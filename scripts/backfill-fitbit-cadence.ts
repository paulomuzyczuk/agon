import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import { getValidAccessToken } from '../services/googleHealth/oauth';
import { GoogleHealthRateLimitError } from '../services/googleHealth/client';
import { fetchWristStepsBuckets } from '../services/googleHealth/steps';
import { resampleCadence, bucketCoverageFraction } from '../lib/fitbitCadence';
import { loadDistanceStreams } from '../services/bestEfforts';
import { updateFitbitCadence, type StreamSource } from '../services/runStreams';

// Per-run granular Fitbit-WRIST steps pull (services/googleHealth/steps.ts),
// resampled onto each distance-bearing run_streams row's own time axis
// (lib/fitbitCadence.ts) — an independent second opinion on run-stop
// detection alongside the existing GPS-speed and phone-cadence methods (see
// lib/movingTime.ts, docs/methodology-log.md 2026-09-05).
//
// Live-probed 2026-09-05: the wrist device (`FITBIT / Google Fitbit Air`) has
// NO steps data at all before 2026-07-01 in this account, and even after that
// date its per-run coverage is bimodal — most runs 80-101% of expected
// 1-minute buckets, several under 15% (band off-wrist/desynced for that run).
// A run with mostly-null coverage would, if written, have
// deriveMovingFlagsFromCadence's "null means moving" convention silently read
// as "never stopped" — not a genuine second opinion, just an artifact of
// missing data. So this backfill only WRITES fitbit_cadence for runs meeting
// a coverage gate; runs below it are reported but skipped.
//
//   pnpm fc:backfill            DRY RUN — pull, resample, print, no writes
//   pnpm fc:backfill --write    upsert fitbit_cadence for runs meeting the gate
//
// Idempotent: re-running recomputes + overwrites fitbit_cadence in place.

const MIN_COVERAGE = 0.5; // fraction of expected 1-minute buckets present

function parseArgs(argv: string[]): { write: boolean } {
  return { write: argv.includes('--write') };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  loadEnv();
  const { write } = parseArgs(process.argv.slice(2));
  logger.info('starting fitbit-cadence backfill', { job: 'fitbit-cadence', write });

  const token = await getValidAccessToken();
  const streams = await loadDistanceStreams();
  const eligible = streams.filter((s) => s.startedAt != null);

  const out: string[] = [];
  out.push('');
  out.push(
    `Distance-bearing streams: ${streams.length}  (${eligible.length} with a known started_at to window against)`,
  );
  out.push('');

  let written = 0;
  let skippedLowCoverage = 0;
  let skippedNoData = 0;
  let rateLimited = false;
  const allCoveredValues: number[] = [];

  for (const s of eligible) {
    if (rateLimited) break;
    const startMs = Date.parse(s.startedAt!);
    const lastT = s.timeS[s.timeS.length - 1] ?? 0;
    const endMs = startMs + lastT * 1000;
    try {
      const buckets = await fetchWristStepsBuckets(token, startMs, endMs);
      const coverage = bucketCoverageFraction(buckets, lastT);
      if (buckets.length === 0) {
        skippedNoData++;
        out.push(`  ${s.runId.slice(0, 8)} (${s.source}) — no wrist steps data, coverage 0.0%`);
        continue;
      }
      const { cadence, coveredSamples } = resampleCadence(buckets, s.timeS, startMs);
      for (const c of cadence) if (c != null) allCoveredValues.push(c);

      if (coverage < MIN_COVERAGE) {
        skippedLowCoverage++;
        out.push(
          `  ${s.runId.slice(0, 8)} (${s.source}) — coverage ${pct(coverage)} (${buckets.length} buckets) BELOW gate, skipped`,
        );
        continue;
      }

      out.push(
        `  ${s.runId.slice(0, 8)} (${s.source}) — coverage ${pct(coverage)} (${buckets.length} buckets, ${coveredSamples}/${s.timeS.length} samples resolved)`,
      );
      if (write) await updateFitbitCadence(s.runId, s.source as StreamSource, cadence);
      written++;
    } catch (err) {
      if (err instanceof GoogleHealthRateLimitError) {
        rateLimited = true;
        out.push(`  RATE LIMITED — stopping early, resume later (${err.message})`);
        break;
      }
      out.push(`  ${s.runId.slice(0, 8)} (${s.source}) — FAILED: ${(err as Error).message}`);
    }
  }

  out.push('');
  out.push(
    `${written} run(s) at/above ${pct(MIN_COVERAGE)} coverage, ${skippedLowCoverage} below the gate, ` +
      `${skippedNoData} with zero wrist data, out of ${eligible.length} eligible.`,
  );

  if (allCoveredValues.length > 0) {
    allCoveredValues.sort((a, b) => a - b);
    const buckets10 = new Map<number, number>();
    for (const v of allCoveredValues) {
      const bucket = Math.floor(v / 10) * 10;
      buckets10.set(bucket, (buckets10.get(bucket) ?? 0) + 1);
    }
    out.push('');
    out.push(`Covered-sample cadence histogram (${allCoveredValues.length} samples, steps/min both-feet, 10-wide buckets):`);
    for (const [bucket, count] of [...buckets10.entries()].sort((a, b) => a[0] - b[0])) {
      out.push(`  ${String(bucket).padStart(4)}-${bucket + 9}: ${count}`);
    }
  }

  out.push('');
  out.push(
    write
      ? `WROTE fitbit_cadence for ${written} stream(s).`
      : `DRY RUN — would write fitbit_cadence for ${written} stream(s). Re-run with --write to persist.`,
  );
  out.push('');
  // eslint-disable-next-line no-console
  console.log(out.join('\n') + '\n');
}

main()
  .catch((err) => {
    logger.error('fitbit-cadence backfill failed', { job: 'fitbit-cadence' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
