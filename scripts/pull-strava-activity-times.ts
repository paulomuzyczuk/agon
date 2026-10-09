import { loadEnv } from './loadEnv';
import { query, closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import { getValidAccessToken } from '../services/strava/oauth';
import {
  listActivitiesPage,
  StravaRateLimitError,
} from '../services/strava/client';
import { isIngestableRun, isIngestableRide } from '../services/strava/mapper';
import {
  linkActivity,
  toActivityTimes,
  upsertActivityTimes,
  reconcile,
  loadRunReconciliationInputs,
  type LinkTarget,
  type StravaActivityTimes,
  type EstimatorStats,
} from '../services/strava/activityTimes';
import type { StravaSummaryActivity } from '../services/strava/types';

// Strava-premium reference pull (MZY-40): Strava's paywall-only moving_time and
// elapsed_time for every run/ride activity, stored in
// public.strava_activity_times and linked to the Agon run/ride they describe,
// then a reconciliation report of Agon's local estimates (lib/movingTime.ts,
// runs.duration_s) against them. Strava is NOT a live source — nothing here
// touches /sync or cron; run it by hand while premium is active.
//
//   pnpm strava:times                  DRY RUN — fetch + link + print counts
//   pnpm strava:times --write          persist, then print the reconciliation
//   pnpm strava:times --report         reconciliation only, from stored rows (no API)
//   ... --after=2026-03-01 --before=…  window the activity scan (default: all)
//
// Cheap: the summary list endpoint carries both fields, ~1 call per 200
// activities. Idempotent (upsert on strava_activity_id); a 429 writes what was
// fetched and stops (re-run to finish).

const STRAVA_MAX_PER_PAGE = 200;
const PAGE_DELAY_MS = 300;

interface Args {
  write: boolean;
  reportOnly: boolean;
  after?: number;
  before?: number;
}

function epochFromDateArg(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms))
    throw new Error(`invalid date '${value}' (use YYYY-MM-DD)`);
  return Math.floor(ms / 1000);
}

function parseArgs(argv: string[]): Args {
  const a: Args = { write: false, reportOnly: false };
  for (const arg of argv) {
    if (arg === '--write') a.write = true;
    else if (arg === '--report') a.reportOnly = true;
    else if (arg.startsWith('--after='))
      a.after = epochFromDateArg(arg.slice(8));
    else if (arg.startsWith('--before='))
      a.before = epochFromDateArg(arg.slice(9));
  }
  return a;
}

async function loadTargets(table: 'runs' | 'rides'): Promise<LinkTarget[]> {
  const { rows } = await query<{
    id: string;
    started_at: Date;
    duration_s: number;
    distance_km: string;
    source: string;
    external_id: string | null;
  }>(
    // Match on the source's own start (a missed-start correction moves
    // started_at earlier — MZY-253).
    `SELECT id, COALESCE(source_started_at, started_at) AS started_at,
            duration_s, distance_km, source, external_id
       FROM public.${table}
      WHERE started_at IS NOT NULL`,
  );
  return rows.map((r) => ({
    id: r.id,
    startedAtMs: r.started_at.getTime(),
    durationS: r.duration_s,
    distanceKm: Number(r.distance_km),
    source: r.source,
    externalId: r.external_id,
  }));
}

function fmtS(s: number): string {
  const sign = s < 0 ? '−' : '+';
  return `${sign}${Math.abs(s).toFixed(0)}s`;
}

function reportLines(stats: EstimatorStats[]): string[] {
  const out: string[] = [];
  out.push('Reconciliation vs Strava (local − Strava):');
  out.push(
    `  ${'estimator'.padEnd(34)} ${'vs'.padEnd(8)} ${'n'.padStart(4)} ${'bias'.padStart(7)} ` +
      `${'MAE'.padStart(6)} ${'MAPE'.padStart(6)} ${'≤30s'.padStart(6)}`,
  );
  for (const s of stats) {
    out.push(
      `  ${s.estimator.padEnd(34)} ${s.reference.padEnd(8)} ${String(s.n).padStart(4)} ` +
        `${fmtS(s.meanBiasS).padStart(7)} ${`${s.maeS.toFixed(0)}s`.padStart(6)} ` +
        `${`${s.mapePct.toFixed(1)}%`.padStart(6)} ${`${s.within30sPct.toFixed(0)}%`.padStart(6)}`,
    );
  }
  for (const s of stats) {
    if (!s.worst.length) continue;
    out.push('');
    out.push(`  worst — ${s.estimator} vs ${s.reference}:`);
    for (const w of s.worst) {
      out.push(
        `    ${w.label}  local ${w.localS}s  strava ${w.stravaS}s  (${fmtS(w.deltaS)})`,
      );
    }
  }
  return out;
}

async function printReport(): Promise<void> {
  const inputs = await loadRunReconciliationInputs();
  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      `Runs linked to a Strava activity: ${inputs.length}`,
      ...reportLines(reconcile(inputs)),
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  logger.info('starting strava activity-times pull', {
    job: 'strava-times',
    ...args,
  });

  if (args.reportOnly) {
    await printReport();
    return;
  }

  const token = await getValidAccessToken();
  const [runs, rides] = await Promise.all([
    loadTargets('runs'),
    loadTargets('rides'),
  ]);

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
      for (const act of batch) {
        if (isIngestableRun(act) || isIngestableRide(act)) activities.push(act);
      }
      if (batch.length < STRAVA_MAX_PER_PAGE) break;
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }
  } catch (err) {
    if (err instanceof StravaRateLimitError) {
      rateLimited = true;
      logger.warn('rate-limited while listing activities — partial set', {
        job: 'strava-times',
      });
    } else throw err;
  }

  const claimed = new Set<string>();
  const rows: StravaActivityTimes[] = [];
  const counts = {
    run: 0,
    ride: 0,
    runLinked: 0,
    rideLinked: 0,
    viaId: 0,
    viaTime: 0,
  };
  for (const act of activities) {
    const kind = isIngestableRun(act) ? 'run' : 'ride';
    const link = linkActivity(act, kind === 'run' ? runs : rides, claimed);
    if (link) {
      claimed.add(link.id);
      if (link.via === 'external_id') counts.viaId++;
      else counts.viaTime++;
    }
    counts[kind]++;
    if (link && kind === 'run') counts.runLinked++;
    if (link && kind === 'ride') counts.rideLinked++;
    rows.push(
      toActivityTimes(
        act,
        kind,
        kind === 'run' ? { runId: link?.id } : { rideId: link?.id },
      ),
    );
  }

  const withPause = rows.filter((r) => r.elapsedTimeS > r.movingTimeS);
  const out: string[] = [''];
  out.push(
    `Strava activities: ${rows.length}${rateLimited ? ' (PARTIAL — rate-limited)' : ''}`,
  );
  out.push(
    `  runs:  ${counts.run}  (linked to an Agon run: ${counts.runLinked})`,
  );
  out.push(
    `  rides: ${counts.ride}  (linked to an Agon ride: ${counts.rideLinked})`,
  );
  out.push(`  linked by id: ${counts.viaId}, by time match: ${counts.viaTime}`);
  out.push(`  elapsed > moving (Strava saw a pause): ${withPause.length}`);

  if (!args.write) {
    out.push(
      '',
      'DRY RUN — no changes written. Re-run with --write to apply.',
      '',
    );
    // eslint-disable-next-line no-console
    console.log(out.join('\n'));
    return;
  }

  const written = await upsertActivityTimes(rows);
  out.push(`WROTE ${written} rows to public.strava_activity_times.`);
  // eslint-disable-next-line no-console
  console.log(out.join('\n'));
  await printReport();
}

main()
  .catch((err) => {
    logger.error(
      'strava activity-times pull failed',
      { job: 'strava-times' },
      err,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
