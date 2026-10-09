import { loadEnv } from './loadEnv';
import { query, closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import { getValidAccessToken } from '../services/strava/oauth';
import { listActivitiesPage, StravaRateLimitError } from '../services/strava/client';
import { fetchStravaRunStreams } from '../services/strava/streams';
import { isIngestableRun, mapActivityToRun } from '../services/strava/mapper';
import { upsertRun } from '../services/strava/ingest';
import {
  matchActivity,
  type ExistingRunLite,
} from '../services/strava/matchEnrich';
import type { StravaSummaryActivity } from '../services/strava/types';
import {
  updateRunStartGps,
  updateRunHr,
  updateRunElevationGain,
} from '../services/runs';
import { hasRunStreams, upsertRunStreams } from '../services/runStreams';

// Enrich EXISTING runs with Strava's richer data instead of inserting duplicate
// source='strava' rows. Matches each Strava activity to the run we already hold
// (source='google_health') by time overlap, then fills GPS start coords,
// elevation, and max HR (COALESCE — never clobbers) and attaches the per-run
// HR/altitude/pace/cadence time series under run_streams source='strava'.
//
// See services/strava/matchEnrich.ts for the why. One-time backfill enabled by a
// month of Strava premium reopening API access.
//
//   pnpm tsx scripts/enrich-runs-from-strava.ts             DRY RUN (no writes)
//   pnpm tsx scripts/enrich-runs-from-strava.ts --write     apply enrichment
//   ... --after=2026-03-01 --before=2026-08-01              window the activity pull
//   ... --no-streams                                        skip the per-run stream calls
//
// Idempotent + resumable: re-running updates the same rows; runs that already
// have a strava stream are skipped; a 429 stops cleanly (re-run to resume).

const STRAVA_MAX_PER_PAGE = 200;
const PAGE_DELAY_MS = 300;
/** Flag a match whose distance disagrees this much — a match to eyeball, not reject. */
const SUSPECT_DIST_PCT = 25;

interface Args {
  write: boolean;
  withStreams: boolean;
  /** Insert Strava-only runs (no matching DB run) as new source='strava' rows. */
  insertUnmatched: boolean;
  /** Re-fetch streams for matched runs even if a strava stream already exists
   * (backfills the new GPS lat/lng track into rows streamed before it existed). */
  refreshStreams: boolean;
  after?: number;
  before?: number;
}

function epochFromDateArg(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`invalid date '${value}' (use YYYY-MM-DD)`);
  return Math.floor(ms / 1000);
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    write: false,
    withStreams: true,
    insertUnmatched: false,
    refreshStreams: false,
  };
  for (const arg of argv) {
    if (arg === '--write') a.write = true;
    else if (arg === '--no-streams') a.withStreams = false;
    else if (arg === '--insert-unmatched') a.insertUnmatched = true;
    else if (arg === '--refresh-streams') a.refreshStreams = true;
    else if (arg.startsWith('--after=')) a.after = epochFromDateArg(arg.slice(8));
    else if (arg.startsWith('--before=')) a.before = epochFromDateArg(arg.slice(9));
  }
  return a;
}

interface RunRow extends ExistingRunLite {
  startLat: number | null;
  elevationGainM: number | null;
  maxHr: number | null;
}

async function loadExistingRuns(): Promise<RunRow[]> {
  const { rows } = await query<{
    id: string;
    started_at: Date | null;
    duration_s: number;
    distance_km: string;
    start_lat: string | null;
    elevation_gain_m: string | null;
    max_hr: number | null;
  }>(
    `SELECT id, started_at, duration_s, distance_km, start_lat, elevation_gain_m, max_hr
       FROM public.runs
      WHERE started_at IS NOT NULL`,
  );
  return rows.map((r) => ({
    id: r.id,
    startedAtMs: r.started_at!.getTime(),
    durationS: r.duration_s,
    distanceKm: Number(r.distance_km),
    startLat: r.start_lat == null ? null : Number(r.start_lat),
    elevationGainM: r.elevation_gain_m == null ? null : Number(r.elevation_gain_m),
    maxHr: r.max_hr,
  }));
}

function activityGps(a: StravaSummaryActivity): { lat: number; lng: number } | null {
  const ll = a.start_latlng;
  if (Array.isArray(ll) && ll.length === 2 && ll[0] != null && ll[1] != null) {
    return { lat: ll[0], lng: ll[1] };
  }
  return null;
}

/** Overlap slack for the insert-safety check, in ms. */
const OVERLAP_SLACK_MS = 120_000;

/**
 * True if the activity's time window overlaps ANY existing run (regardless of the
 * tighter match threshold). An unmatched activity that still overlaps a run is a
 * split/merge ambiguity — e.g. a 6 km Strava run whose window sits inside a 12.7 km
 * run Google Health merged that day — so it must NOT be inserted as a fresh row.
 */
function overlapsAnyRun(a: StravaSummaryActivity, runs: RunRow[]): boolean {
  const aStart = Date.parse(a.start_date);
  const aEnd = aStart + a.elapsed_time * 1000;
  return runs.some((r) => {
    const rStart = r.startedAtMs;
    const rEnd = r.startedAtMs + r.durationS * 1000;
    return aStart < rEnd + OVERLAP_SLACK_MS && aEnd > rStart - OVERLAP_SLACK_MS;
  });
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  logger.info('starting strava match-and-enrich', {
    job: 'strava-enrich',
    ...args,
  });

  const token = await getValidAccessToken();
  const runs = await loadExistingRuns();

  // 1) Pull all (windowed) Strava run activities.
  const activities: StravaSummaryActivity[] = [];
  let rateLimited = false;
  try {
    for (let page = 1; page <= 100; page++) {
      const batch = await listActivitiesPage(token, {
        page,
        perPage: STRAVA_MAX_PER_PAGE,
        after: args.after,
        before: args.before,
      });
      if (batch.length === 0) break;
      for (const act of batch) if (isIngestableRun(act)) activities.push(act);
      if (batch.length < STRAVA_MAX_PER_PAGE) break;
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }
  } catch (err) {
    if (err instanceof StravaRateLimitError) {
      rateLimited = true;
      logger.warn('rate-limited while listing activities — partial set', {
        job: 'strava-enrich',
      });
    } else throw err;
  }

  // 2) Match each activity to an existing run.
  const runById = new Map(runs.map((r) => [r.id, r]));
  const matchedRunIds = new Set<string>();
  const collisions: string[] = [];
  interface Matched {
    activity: StravaSummaryActivity;
    run: RunRow;
    startDeltaS: number;
    distDeltaPct: number | null;
  }
  const matched: Matched[] = [];
  const unmatched: StravaSummaryActivity[] = [];

  for (const act of activities) {
    const m = matchActivity(
      {
        id: act.id,
        startMs: Date.parse(act.start_date),
        durationS: act.elapsed_time,
        distanceKm: act.distance / 1000,
      },
      runs,
    );
    if (!m) {
      unmatched.push(act);
      continue;
    }
    if (matchedRunIds.has(m.run.id)) {
      collisions.push(
        `run ${m.run.id} matched by >1 activity (latest: ${act.id} "${act.name ?? ''}")`,
      );
    }
    matchedRunIds.add(m.run.id);
    matched.push({
      activity: act,
      run: runById.get(m.run.id)!,
      startDeltaS: m.startDeltaS,
      distDeltaPct: m.distDeltaPct,
    });
  }

  // 3) Split matches into CONFIDENT (safe to enrich) and REVIEW (distance
  // disagrees too much — likely a split run, e.g. Strava logged two activities
  // that Google Health recorded as one). We never auto-write a review match: its
  // GPS/elevation/stream belong to a different distance than the run holds.
  const isConfident = (m: Matched): boolean =>
    m.distDeltaPct == null || Math.abs(m.distDeltaPct) <= SUSPECT_DIST_PCT;
  const confident = matched.filter(isConfident);
  const review = matched.filter((m) => !isConfident(m));

  // Unmatched split into cleanly-insertable (no overlap with anything) and
  // ambiguous (overlaps an existing run — a split/merge case, never inserted).
  const insertable = unmatched.filter((a) => !overlapsAnyRun(a, runs));
  const ambiguousUnmatched = unmatched.filter((a) => overlapsAnyRun(a, runs));

  let gainGps = 0;
  let gainElevation = 0;
  let gainMaxHr = 0;
  let needStreams = 0;
  for (const m of confident) {
    if (m.run.startLat == null && activityGps(m.activity)) gainGps++;
    if (m.run.elevationGainM == null && m.activity.total_elevation_gain != null)
      gainElevation++;
    if (m.run.maxHr == null && m.activity.max_heartrate != null) gainMaxHr++;
    if (
      args.withStreams &&
      (args.refreshStreams || !(await hasRunStreams(m.run.id, 'strava')))
    )
      needStreams++;
  }
  const suspects = review.map(
    (m) =>
      `  ${m.activity.start_date_local.slice(0, 10)} "${m.activity.name ?? ''}" ` +
      `strava=${(m.activity.distance / 1000).toFixed(2)}km vs run=${m.run.distanceKm.toFixed(2)}km ` +
      `(Δ${m.distDeltaPct?.toFixed(0)}%, start Δ${m.startDeltaS}s)`,
  );

  // ---- Report ----
  const out: string[] = [];
  out.push('');
  out.push(`Strava activities (ingestable runs): ${activities.length}${rateLimited ? ' (PARTIAL — rate-limited)' : ''}`);
  out.push(`Existing DB runs (with start time):  ${runs.length}`);
  out.push(`Matched to an existing run:          ${matched.length}`);
  out.push(`  confident (safe to enrich):        ${confident.length}`);
  out.push(`    → would gain GPS start coords:   ${gainGps}  (unlocks weather backfill)`);
  out.push(`    → would gain elevation:          ${gainElevation}`);
  out.push(`    → would gain max HR:             ${gainMaxHr}`);
  if (args.withStreams)
    out.push(`    → would fetch a strava stream:   ${needStreams}`);
  out.push(`  needs review (distance disagrees): ${review.length}  (NOT written)`);
  out.push(`Strava runs with NO matching DB run: ${unmatched.length} (Strava-only / after last GH sync)`);
  out.push(`DB runs with NO Strava match:        ${runs.length - matchedRunIds.size}`);
  if (collisions.length) {
    out.push('');
    out.push(`⚠ ${collisions.length} run(s) matched by multiple activities:`);
    for (const c of collisions.slice(0, 10)) out.push(`  ${c}`);
  }
  if (suspects.length) {
    out.push('');
    out.push(`⚠ ${suspects.length} match(es) SKIPPED — distance Δ > ${SUSPECT_DIST_PCT}% (likely split runs; review manually):`);
    for (const s of suspects.slice(0, 15)) out.push(s);
  }
  if (insertable.length) {
    out.push('');
    const fate = args.insertUnmatched
      ? 'will INSERT as source=strava runs'
      : 'not written — pass --insert-unmatched to add them';
    out.push(`Insertable Strava-only runs (${fate}) — ${Math.min(insertable.length, 20)} of ${insertable.length} shown:`);
    for (const a of insertable.slice(0, 20)) {
      out.push(
        `  ${a.start_date_local.slice(0, 10)} "${a.name ?? ''}" ${(a.distance / 1000).toFixed(2)}km`,
      );
    }
  }
  if (ambiguousUnmatched.length) {
    out.push('');
    out.push(`⚠ ${ambiguousUnmatched.length} unmatched run(s) SKIPPED from insert — time-overlap an existing run (split/merge; review manually):`);
    for (const a of ambiguousUnmatched.slice(0, 10)) {
      out.push(
        `  ${a.start_date_local.slice(0, 10)} "${a.name ?? ''}" ${(a.distance / 1000).toFixed(2)}km`,
      );
    }
  }
  out.push('');

  if (!args.write) {
    out.push('DRY RUN — no changes written. Re-run with --write to apply.');
    // eslint-disable-next-line no-console
    console.log(out.join('\n') + '\n');
    return;
  }

  // ---- Write path ----
  let gpsWritten = 0;
  let elevationWritten = 0;
  let maxHrWritten = 0;
  let streamsWritten = 0;
  let stoppedOnRateLimit = false;
  const enrichedRunIds = new Set<string>();
  try {
    for (const m of confident) {
      // Collision guard: if two confident activities matched the same run, the
      // first (newest, Strava pages newest-first) wins; skip the rest.
      if (enrichedRunIds.has(m.run.id)) continue;
      enrichedRunIds.add(m.run.id);
      const gps = activityGps(m.activity);
      if (gps) {
        await updateRunStartGps(m.run.id, gps.lat, gps.lng);
        if (m.run.startLat == null) gpsWritten++;
      }
      if (m.activity.total_elevation_gain != null) {
        await updateRunElevationGain(m.run.id, m.activity.total_elevation_gain);
        if (m.run.elevationGainM == null) elevationWritten++;
      }
      if (m.activity.max_heartrate != null) {
        await updateRunHr(m.run.id, null, Math.round(m.activity.max_heartrate));
        if (m.run.maxHr == null) maxHrWritten++;
      }
      if (
        args.withStreams &&
        (args.refreshStreams || !(await hasRunStreams(m.run.id, 'strava')))
      ) {
        const streams = await fetchStravaRunStreams(token, m.activity.id);
        if (streams) {
          await upsertRunStreams(m.run.id, 'strava', streams);
          streamsWritten++;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  } catch (err) {
    if (err instanceof StravaRateLimitError) {
      stoppedOnRateLimit = true;
      logger.warn('rate-limited during enrichment — re-run to resume', {
        job: 'strava-enrich',
      });
    } else throw err;
  }

  // ---- Insert unmatched Strava-only runs (opt-in) ----
  // These have no overlapping DB run, so they're new activities, not duplicates.
  // Inserted as source='strava' with full summary metrics + GPS + streams.
  let inserted = 0;
  let insertedStreams = 0;
  if (args.insertUnmatched && !stoppedOnRateLimit) {
    try {
      for (const act of insertable) {
        const run = mapActivityToRun(act);
        const result = await upsertRun(run);
        if (result.status === 'inserted') inserted++;
        if (args.withStreams && !(await hasRunStreams(result.id, 'strava'))) {
          const streams = await fetchStravaRunStreams(token, act.id);
          if (streams) {
            await upsertRunStreams(result.id, 'strava', streams);
            insertedStreams++;
          }
          await new Promise((r) => setTimeout(r, 150));
        }
      }
    } catch (err) {
      if (err instanceof StravaRateLimitError) {
        stoppedOnRateLimit = true;
        logger.warn('rate-limited during insert — re-run to resume', {
          job: 'strava-enrich',
        });
      } else throw err;
    }
  }

  out.push(
    `WROTE: ${gpsWritten} GPS coords, ${elevationWritten} elevation, ` +
      `${maxHrWritten} max HR, ${streamsWritten} streams` +
      `${args.insertUnmatched ? `; inserted ${inserted} new runs (${insertedStreams} streams)` : ''}` +
      `${stoppedOnRateLimit ? ' (STOPPED on rate limit — re-run to resume)' : ''}.`,
  );
  if (gpsWritten > 0)
    out.push('Next: `pnpm weather:backfill` to enrich the newly-GPS runs.');
  out.push('');
  // eslint-disable-next-line no-console
  console.log(out.join('\n') + '\n');
}

main()
  .catch((err) => {
    logger.error('strava enrich failed', { job: 'strava-enrich' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
