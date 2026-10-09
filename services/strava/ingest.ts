import { query } from '../db';
import { logger } from '../logger';
import { upsertGear, linkRunGear } from '../gear';
import { hrmForRun } from '../../lib/gear';
import { hasRunStreams, upsertRunStreams } from '../runStreams';
import type { RunRecord } from '../../lib/types';
import { upsertSetKeepingCorrections } from '../activityCorrections';
import { getValidAccessToken } from './oauth';
import {
  getGearName,
  listActivitiesPage,
  StravaRateLimitError,
} from './client';
import { fetchStravaRunStreams } from './streams';
import { isIngestableRun, mapActivityToRun } from './mapper';
import {
  classifyIncomingActivity,
  releaseStravaActivityId,
  supersedeActivities,
} from '../activitySources';

// Historical backfill: page through the athlete's Strava activities, keep the
// runs, and upsert them into public.runs keyed on strava_activity_id.

const STRAVA_MAX_PER_PAGE = 200;

export interface BackfillOptions {
  perPage?: number;
  /** epoch seconds — only ingest activities after this time (incremental sync). */
  after?: number;
  before?: number;
  resolveGear?: boolean;
  /**
   * Also pull each run's full time series (GPS, speed, moving, cadence, HR when
   * present) into run_streams. Default true — all available data is kept. It's
   * a per-activity call, so heavier on the rate limit; resumable — runs that
   * already have a stream are skipped.
   */
  withStreams?: boolean;
  pageDelayMs?: number;
  /** safety cap so a bug can't loop forever against the API. */
  maxPages?: number;
}

export interface BackfillSummary {
  pagesFetched: number;
  activitiesSeen: number;
  runsInserted: number;
  runsUpdated: number;
  skippedNonRun: number;
  /**
   * Runs not stored because an equal-or-higher-priority twin already exists
   * (lib/activitySourcePriority.ts) — e.g. an Agon live recording or a Garmin
   * export of the same run. Their Strava stream still lands on that twin.
   */
  runsSkippedExisting: number;
  /** Lower-priority twins (Google Health) replaced by the Strava run. */
  runsSuperseded: number;
  /** run_streams rows fetched this pass (0 unless withStreams). */
  streamsFetched: number;
  /** true if the run stopped early because Strava returned HTTP 429. */
  rateLimited: boolean;
}

export interface UpsertRunResult {
  id: string;
  status: 'inserted' | 'updated';
}

/**
 * Idempotent upsert, keyed on `(source, external_id)` (the source-agnostic run
 * identity — so Strava, Google Health, and file imports all share this one write
 * path). On conflict it refreshes ONLY the objective ingested columns and
 * deliberately leaves the qualitative fields (fueling, perceived_effort, pain_*,
 * general_notes) and weather enrichment untouched — those are owned by the
 * voice-note and Open-Meteo pipelines, so re-running an ingest must never clobber
 * them. Hand-corrected columns (runs.corrected_fields, see
 * services/activityCorrections.ts) keep their stored value too. Returns the run
 * id and whether it was new (the id is needed to link gear in run_gear).
 *
 * NOTE: callers must set `external_id` (Strava/Google Health mappers do). A run
 * with a NULL external_id would never conflict (NULLs are distinct), so it would
 * insert a fresh row every call — fine for one-shot manual inserts, which use
 * services/runs.ts insertManualRun rather than this path.
 */
export async function upsertRun(r: RunRecord): Promise<UpsertRunResult> {
  const { rows } = await query<{ id: string; inserted: boolean }>(
    `INSERT INTO public.runs
       (date, started_at, start_lat, start_lng, block, week, distance_km,
        duration_s, avg_hr, max_hr, avg_pace_s_per_km, elevation_gain_m,
        shoe_used, strava_activity_id, external_id, source, origin)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (source, external_id) DO UPDATE SET
       ${upsertSetKeepingCorrections('runs')}
     RETURNING id, (xmax = 0) AS inserted`,
    [
      r.date,
      r.started_at,
      r.start_lat,
      r.start_lng,
      r.block,
      r.week,
      r.distance_km,
      r.duration_s,
      r.avg_hr,
      r.max_hr,
      r.avg_pace_s_per_km,
      r.elevation_gain_m,
      r.shoe_used,
      r.strava_activity_id,
      r.external_id,
      r.source,
      r.origin,
    ],
  );
  const row = rows[0]!;
  return { id: row.id, status: row.inserted ? 'inserted' : 'updated' };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function backfillHistoricalRuns(
  opts: BackfillOptions = {},
): Promise<BackfillSummary> {
  const perPage = opts.perPage ?? STRAVA_MAX_PER_PAGE;
  const resolveGear = opts.resolveGear ?? true;
  const withStreams = opts.withStreams ?? true;
  const pageDelayMs = opts.pageDelayMs ?? 250;
  const maxPages = opts.maxPages ?? 100;

  const accessToken = await getValidAccessToken();
  const gearCache = new Map<string, ResolvedGear | null>();

  const summary: BackfillSummary = {
    pagesFetched: 0,
    activitiesSeen: 0,
    runsInserted: 0,
    runsUpdated: 0,
    skippedNonRun: 0,
    runsSkippedExisting: 0,
    runsSuperseded: 0,
    streamsFetched: 0,
    rateLimited: false,
  };

  try {
    for (let page = 1; page <= maxPages; page++) {
      const activities = await listActivitiesPage(accessToken, {
        page,
        perPage,
        after: opts.after,
        before: opts.before,
      });
      summary.pagesFetched++;
      if (activities.length === 0) break; // reached the end of history

      for (const activity of activities) {
        summary.activitiesSeen++;
        if (!isIngestableRun(activity)) {
          summary.skippedNonRun++;
          continue;
        }

        let shoe: ResolvedGear | null = null;
        if (resolveGear && activity.gear_id) {
          shoe = await resolveStravaGear(
            accessToken,
            activity.gear_id,
            gearCache,
          );
        }

        const run = mapActivityToRun(activity, {
          shoeName: shoe?.name ?? null,
        });

        // Source priority (MZY-225): an Agon/export twin of this run wins — keep
        // it, but still hand it Strava's richer stream (GPS, cadence) when it
        // has none. A Google Health twin loses: it's merged into this row below.
        const overlap = await classifyIncomingActivity('run', run);
        const winner = overlap.blocking[0];
        if (winner) {
          summary.runsSkippedExisting++;
          if (withStreams && !(await hasRunStreams(winner.id, 'strava'))) {
            const streams = await fetchStravaRunStreams(
              accessToken,
              activity.id,
            );
            if (streams) {
              await upsertRunStreams(winner.id, 'strava', streams);
              summary.streamsFetched++;
            }
          }
          continue;
        }

        await releaseStravaActivityId(
          overlap.supersede,
          run.strava_activity_id,
        );
        const result = await upsertRun(run);
        if (result.status === 'inserted') summary.runsInserted++;
        else summary.runsUpdated++;
        summary.runsSuperseded += await supersedeActivities(
          'run',
          result.id,
          overlap.supersede,
        );

        // Record the gear worn: the Strava shoe, plus the HRM in use on this
        // run's date (H9 through June 2026, Garmin HRM 200 from July 2026) — but
        // ONLY when the run actually has HR data. No HR recorded => assume no
        // strap was worn, link none.
        if (shoe) await linkRunGear(result.id, shoe.gearId);
        const hrm = hrmForRun(run.avg_hr, run.date);
        if (hrm) {
          await upsertGear({
            gear_id: hrm.gear_id,
            name: hrm.name,
            brand: hrm.brand,
            source: 'local',
            category: 'hrm',
          });
          await linkRunGear(result.id, hrm.gear_id);
        }

        // Heavy pass: pull the full time series (GPS, speed, moving, cadence,
        // altitude, HR when present) — useful with or without an HR strap.
        // Skip runs already streamed so a re-run resumes cheaply.
        if (withStreams && !(await hasRunStreams(result.id, 'strava'))) {
          const streams = await fetchStravaRunStreams(accessToken, activity.id);
          if (streams) {
            await upsertRunStreams(result.id, 'strava', streams);
            summary.streamsFetched++;
          }
        }
      }

      if (activities.length < perPage) break; // last (partial) page
      await sleep(pageDelayMs);
    }
  } catch (err) {
    if (err instanceof StravaRateLimitError) {
      summary.rateLimited = true;
      logger.warn('strava backfill stopped on rate limit — resume later', {
        job: 'strava-backfill',
        ...summary,
      });
      return summary;
    }
    throw err;
  }

  logger.info('strava backfill complete', {
    job: 'strava-backfill',
    ...summary,
  });
  return summary;
}

interface ResolvedGear {
  gearId: string;
  name: string;
}

/**
 * Resolve a Strava gear_id to a catalog entry: fetch its name from Strava, upsert
 * it into public.gear (source 'strava', keyed on Strava's own id), and return
 * {gearId, name}. Per-run cache avoids re-fetching a shoe worn on many runs. A
 * failed lookup degrades to null (run keeps no shoe) rather than aborting the
 * whole backfill; a rate-limit error propagates so the caller can stop cleanly.
 */
async function resolveStravaGear(
  accessToken: string,
  stravaGearId: string,
  cache: Map<string, ResolvedGear | null>,
): Promise<ResolvedGear | null> {
  const cached = cache.get(stravaGearId);
  if (cached !== undefined) return cached;

  let resolved: ResolvedGear | null = null;
  try {
    const name = await getGearName(accessToken, stravaGearId);
    await upsertGear({
      gear_id: stravaGearId,
      name,
      source: 'strava',
      category: 'shoe',
    });
    resolved = { gearId: stravaGearId, name };
  } catch (err) {
    if (err instanceof StravaRateLimitError) throw err; // let the caller stop
    logger.warn('strava gear lookup failed — leaving shoe null', {
      job: 'strava-backfill',
      gearId: stravaGearId,
    });
  }
  cache.set(stravaGearId, resolved);
  return resolved;
}
