import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import { FULL_RUN_EFFORT_NAME } from '../lib/bestEfforts';
import {
  bestEffortsForRun,
  loadRunsForBestEffort,
  loadDistanceStreams,
  upsertRunBestEffort,
  loadStravaBucketPrsForComparison,
  deleteRunBestEfforts,
  type DistanceStreamRow,
  type BestEffortRow,
} from '../services/bestEfforts';

// Backfill source-agnostic best efforts (distance, time PRs) from Agon's own
// runs/run_streams — supersedes public.strava_best_efforts (a frozen,
// one-time Strava-premium pull) as the LIVE input to race predictions, so
// runs from any source (Google Health, manual Telegram, file imports) keep
// feeding the Riegel-exponent recalibration. Pure math is in
// lib/bestEfforts.ts.
//
// Raw elapsed time overstates a run interrupted by a forced stop (a red
// light) and, if naively "fixed" by just subtracting the stop, understates it
// right back (crediting the rest-boosted pace right after). Streams that
// carry Strava's per-sample `moving` flags (2026-09-05, `lib/movingTime.ts`)
// get a corrected time axis BEFORE the sliding-window search runs — the
// search itself (findBucketEffort/fullStreamEffort) is untouched, it just reads
// off a different time axis for the same distances. Streams without `moving`
// (Google Health) search the raw axis as before, same as the whole-run
// fallback (no stream at all — nothing to correct).
//
// Google-Health-ONLY runs (source='google_health', no distance-bearing
// run_streams row of ANY source) are EXCLUDED entirely, not given a
// whole-run-fallback row (decision 2026-09-05, athlete-directed). Google
// Health's aggregate distance/duration for a run with no attached GPS track
// comes from the Fitbit Air's own auto-detection — the device has no GPS
// chip, so this figure is materially less precise than a GPS-verified
// stream (Strava, a phone-recorded TCX/GPX) or even the athlete's own manual
// estimate. Caught live 2026-09-05: an unverified ~10 km google_health
// whole-run point (faster than the athlete's actual GPS-verified 10K PR)
// was silently the single largest "beats the curve" outlier feeding the
// Riegel fit and the VDOT reference. A run keeps a stream-tier row (or,
// for any OTHER source with no stream — e.g. a manually logged run with no
// GPS track — the existing whole-run fallback) exactly as before; only the
// Google-Health-no-stream combination is now refused.
//
//   pnpm be:backfill            DRY RUN — compute + print, no writes
//   pnpm be:backfill --write    upsert into public.run_best_efforts (and
//                               prune any stale rows for now-excluded runs)
//
// Idempotent ((run_id, effort_name) PK): re-running recomputes + overwrites.

const STRAVA_MATCH_TOLERANCE_M = 50;

function parseArgs(argv: string[]): { write: boolean } {
  return { write: argv.includes('--write') };
}

/** Seconds -> h:mm:ss / mm:ss. */
function fmt(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  loadEnv();
  const { write } = parseArgs(process.argv.slice(2));
  logger.info('starting best-efforts backfill', { job: 'best-efforts', write });

  const runs = await loadRunsForBestEffort();
  const streamsByRun = new Map<string, DistanceStreamRow[]>();
  for (const s of await loadDistanceStreams()) {
    const arr = streamsByRun.get(s.runId) ?? [];
    arr.push(s);
    streamsByRun.set(s.runId, arr);
  }

  const rows: BestEffortRow[] = [];
  const excludedGoogleHealthRunIds: string[] = [];
  let nStreamRuns = 0;
  let nWholeRunRuns = 0;
  let nSkipped = 0;
  let nExcludedGoogleHealthNoStream = 0;
  let nNetAdjustedStrava = 0;
  let nNetAdjustedDerived = 0;
  let totalStopsCredited = 0;
  let totalBonusS = 0;

  for (const run of runs) {
    const r = bestEffortsForRun(run, streamsByRun.get(run.runId) ?? []);
    rows.push(...r.rows);
    if (r.outcome === 'stream') nStreamRuns++;
    else if (r.outcome === 'whole_run') nWholeRunRuns++;
    else if (r.outcome === 'skipped') nSkipped++;
    else {
      // Google-Health-only runs: refused, not given a whole-run fallback (see
      // the module doc comment above).
      excludedGoogleHealthRunIds.push(run.runId);
      nExcludedGoogleHealthNoStream++;
    }
    if (r.netAdjusted) {
      if (r.netAdjusted.via === 'strava') nNetAdjustedStrava++;
      else nNetAdjustedDerived++;
      totalStopsCredited += r.netAdjusted.stops;
      totalBonusS += r.netAdjusted.bonusS;
    }
  }

  if (write) {
    for (const row of rows) await upsertRunBestEffort(row);
    // Prune any rows a PRIOR run of this script wrote for a run that's now
    // excluded (e.g. it used to fall back to whole_run before this rule
    // existed) — upsert alone never removes rows for runs no longer processed.
    await deleteRunBestEfforts(excludedGoogleHealthRunIds);
  }

  const stravaPrs = await loadStravaBucketPrsForComparison();
  function nearestStravaPr(distanceM: number) {
    let best: (typeof stravaPrs)[number] | null = null;
    let bestDelta = STRAVA_MATCH_TOLERANCE_M;
    for (const p of stravaPrs) {
      const delta = Math.abs(p.distanceM - distanceM);
      if (delta <= bestDelta) {
        best = p;
        bestDelta = delta;
      }
    }
    return best;
  }

  const bucketRows = rows.filter((r) => r.effortName !== FULL_RUN_EFFORT_NAME);
  const fullRunRows = rows.filter((r) => r.effortName === FULL_RUN_EFFORT_NAME);
  const bestPerBucket = new Map<string, BestEffortRow>();
  for (const r of bucketRows) {
    const cur = bestPerBucket.get(r.effortName);
    if (!cur || r.elapsedTimeS < cur.elapsedTimeS) bestPerBucket.set(r.effortName, r);
  }

  const out: string[] = [];
  out.push('');
  out.push(`Runs:                 ${runs.length}`);
  out.push(`  stream-derived:     ${nStreamRuns}`);
  out.push(`  whole-run fallback: ${nWholeRunRuns}`);
  out.push(`  excluded (google_health, no stream — Fitbit Air auto-detect): ${nExcludedGoogleHealthNoStream}`);
  out.push(`  skipped (no data):  ${nSkipped}`);
  out.push(
    `  net-time-adjusted:  ${nNetAdjustedStrava + nNetAdjustedDerived} run(s) ` +
      `(${nNetAdjustedStrava} via Strava moving, ${nNetAdjustedDerived} via derived_moving), ` +
      `${totalStopsCredited} forced stop(s), ${totalBonusS.toFixed(1)}s charged back total`,
  );
  out.push(`Rows computed:        ${rows.length}  (${bucketRows.length} bucket, ${fullRunRows.length} full_run)`);
  out.push('');
  out.push('Best bucket split per named distance (fastest across all runs):');
  out.push('  distance          new PR      strava PR (sanity check)   delta');
  for (const [name, r] of [...bestPerBucket.entries()].sort(
    (a, b) => a[1].distanceM - b[1].distanceM,
  )) {
    const strava = nearestStravaPr(r.distanceM);
    const stravaLabel = strava ? `${fmt(strava.elapsedTimeS)} (${strava.effortName})` : '—';
    const delta =
      strava != null ? `${(r.elapsedTimeS - strava.elapsedTimeS).toFixed(1)}s` : '—';
    out.push(
      `  ${name.padEnd(16)}  ${fmt(r.elapsedTimeS).padStart(8)}    ${stravaLabel.padEnd(22)}  ${delta}`,
    );
  }
  out.push('');
  out.push(`Full-run pairs (most recent 15 of ${fullRunRows.length}):`);
  out.push('  date        dist       elapsed   method      src');
  for (const r of fullRunRows.slice(-15).reverse()) {
    out.push(
      `  ${r.achievedAt}  ${(r.distanceM / 1000).toFixed(2).padStart(6)}km  ` +
        `${fmt(r.elapsedTimeS).padStart(8)}  ${r.method.padEnd(10)} ${r.streamSource ?? '-'}`,
    );
  }
  out.push('');
  out.push(
    write
      ? `WROTE ${rows.length} row(s) to public.run_best_efforts.`
      : 'DRY RUN — no changes written. Re-run with --write to persist.',
  );
  out.push('Next: pnpm rp:backfill (now reads public.run_best_efforts, not strava_best_efforts).');
  out.push('');
  // eslint-disable-next-line no-console
  console.log(out.join('\n') + '\n');
}

main()
  .catch((err) => {
    logger.error('best-efforts backfill failed', { job: 'best-efforts' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
