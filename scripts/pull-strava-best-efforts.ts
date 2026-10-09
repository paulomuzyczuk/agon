import { loadEnv } from './loadEnv';
import { query, closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import { getValidAccessToken } from '../services/strava/oauth';
import {
  listActivitiesPage,
  StravaRateLimitError,
} from '../services/strava/client';
import { isIngestableRun } from '../services/strava/mapper';
import {
  fetchActivityBestEfforts,
  pickPrPerDistance,
  getStoredBestEffortActivityIds,
  upsertActivityBestEfforts,
  type StravaBestEffort,
} from '../services/strava/bestEfforts';
import type { StravaSummaryActivity } from '../services/strava/types';

// One-time Strava-premium reference pull: the athlete's per-distance best efforts
// (Strava's paywall-only splits). These are the best-effort PAIRS needed to
// recalibrate the Riegel exponent to the athlete's own physiology
// (CLAUDE.md Premium-Parity #2). Strava is NOT a live source — nothing here
// touches /sync or cron; run it by hand while premium is active.
//
//   pnpm strava:best-efforts                DRY RUN — fetch + print the PR table
//   pnpm strava:best-efforts --write        persist to public.strava_best_efforts
//   ... --refresh                           re-fetch activities already stored
//   ... --after=2026-03-01 --before=…       window the activity scan (default: all)
//
// Resumable + rate-limit-aware: already-pulled activities are skipped, and a 429
// stops the pass cleanly (re-run to resume from where it left off).

const STRAVA_MAX_PER_PAGE = 200;
const PAGE_DELAY_MS = 300;
const DETAIL_DELAY_MS = 150; // between per-activity detail calls

interface Args {
  write: boolean;
  refresh: boolean;
  after?: number;
  before?: number;
}

function epochFromDateArg(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`invalid date '${value}' (use YYYY-MM-DD)`);
  return Math.floor(ms / 1000);
}

function parseArgs(argv: string[]): Args {
  const a: Args = { write: false, refresh: false };
  for (const arg of argv) {
    if (arg === '--write') a.write = true;
    else if (arg === '--refresh') a.refresh = true;
    else if (arg.startsWith('--after=')) a.after = epochFromDateArg(arg.slice(8));
    else if (arg.startsWith('--before=')) a.before = epochFromDateArg(arg.slice(9));
  }
  return a;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function fmtPace(elapsedS: number, distanceM: number): string {
  const secPerKm = elapsedS / (distanceM / 1000);
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}/km`;
}

function fmtTime(totalS: number): string {
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** Load already-stored efforts so the PR table is complete even on a resume. */
async function loadStoredEfforts(): Promise<StravaBestEffort[]> {
  const { rows } = await query<{
    strava_activity_id: string;
    effort_name: string;
    distance_m: string;
    elapsed_time_s: number;
    moving_time_s: number | null;
    pr_rank: number | null;
    started_at: Date | null;
    activity_started_at: Date | null;
  }>(
    `SELECT strava_activity_id, effort_name, distance_m, elapsed_time_s,
            moving_time_s, pr_rank, started_at, activity_started_at
       FROM public.strava_best_efforts`,
  );
  return rows.map((r) => ({
    activityId: Number(r.strava_activity_id),
    name: r.effort_name,
    distanceM: Number(r.distance_m),
    elapsedTimeS: r.elapsed_time_s,
    movingTimeS: r.moving_time_s,
    prRank: r.pr_rank,
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    activityStartedAt: r.activity_started_at
      ? r.activity_started_at.toISOString()
      : null,
  }));
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  logger.info('starting strava best-efforts pull', {
    job: 'strava-best-efforts',
    ...args,
  });

  const token = await getValidAccessToken();

  // 1) List every (windowed) run activity.
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
      await sleep(PAGE_DELAY_MS);
    }
  } catch (err) {
    if (err instanceof StravaRateLimitError) {
      rateLimited = true;
      logger.warn('rate-limited while listing activities — partial set', {
        job: 'strava-best-efforts',
      });
    } else throw err;
  }

  // 2) Skip activities already stored (unless --refresh) so re-runs are cheap.
  const stored = args.refresh
    ? new Set<number>()
    : await getStoredBestEffortActivityIds();
  const toFetch = activities.filter((a) => !stored.has(a.id));

  // 3) Per-activity detail call → best efforts. Write-through when --write so a
  //    mid-pass 429 keeps its progress. Stop cleanly on 429.
  const fetched: StravaBestEffort[] = [];
  let activitiesWithEfforts = 0;
  let rowsWritten = 0;
  let stoppedOnRateLimit = false;
  try {
    for (const act of toFetch) {
      const efforts = await fetchActivityBestEfforts(token, act.id);
      if (efforts.length > 0) {
        activitiesWithEfforts++;
        fetched.push(...efforts);
        if (args.write) rowsWritten += await upsertActivityBestEfforts(efforts);
      }
      await sleep(DETAIL_DELAY_MS);
    }
  } catch (err) {
    if (err instanceof StravaRateLimitError) {
      stoppedOnRateLimit = true;
      logger.warn('rate-limited during detail pull — re-run to resume', {
        job: 'strava-best-efforts',
      });
    } else throw err;
  }

  // 4) Derive the PR table from fresh ∪ already-stored efforts (complete picture).
  const allEfforts = [...fetched, ...(await loadStoredEfforts())];
  const prs = pickPrPerDistance(allEfforts);

  const out: string[] = [];
  out.push('');
  out.push(`Run activities scanned:       ${activities.length}${rateLimited ? ' (PARTIAL — rate-limited listing)' : ''}`);
  out.push(`  already stored (skipped):   ${activities.length - toFetch.length}`);
  out.push(`  queued for detail fetch:    ${toFetch.length}${stoppedOnRateLimit ? ' (stopped early on rate limit)' : ''}`);
  out.push(`Activities with best efforts: ${activitiesWithEfforts}`);
  out.push(`Effort rows fetched this pass: ${fetched.length}`);
  out.push('');
  out.push('Best effort PR per distance (fastest split across all activities):');
  if (prs.length === 0) {
    out.push('  (none yet — run against activities that have Strava best efforts)');
  } else {
    for (const p of prs) {
      const date = (p.activityStartedAt ?? p.startedAt ?? '').slice(0, 10);
      out.push(
        `  ${p.name.padEnd(14)} ${fmtTime(p.elapsedTimeS).padStart(8)}  ` +
          `${fmtPace(p.elapsedTimeS, p.distanceM).padStart(9)}  ` +
          `(${(p.distanceM / 1000).toFixed(2)} km, ${date}, act ${p.activityId})`,
      );
    }
  }
  out.push('');

  if (!args.write) {
    out.push('DRY RUN — no changes written. Re-run with --write to persist.');
  } else {
    out.push(
      `WROTE ${rowsWritten} effort row(s) across ${activitiesWithEfforts} activities` +
        `${stoppedOnRateLimit ? ' (STOPPED on rate limit — re-run to resume)' : ''}.`,
    );
  }
  out.push('');
  // eslint-disable-next-line no-console
  console.log(out.join('\n') + '\n');
}

main()
  .catch((err) => {
    logger.error('strava best-efforts pull failed', {
      job: 'strava-best-efforts',
    }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
