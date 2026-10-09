import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import {
  deriveMovingFlags,
  compareMovingFlags,
  compareConfirmedStops,
  DEFAULT_STOP_SPEED_MPS,
} from '../lib/movingTime';
import { loadDistanceStreams } from '../services/bestEfforts';
import { updateDerivedMoving, type StreamSource } from '../services/runStreams';

// Backfill an in-house "moving" flag (lib/movingTime.ts::deriveMovingFlags) for
// EVERY distance-bearing run_streams row, regardless of source — Strava's real
// `moving` flag is exclusive to its paywalled Streams API (confirmed
// 2026-09-05, CLAUDE.md: a free GPX export carries no such field), so every
// Google Health / file-import stream would otherwise never get one at all.
// Stored as run_streams.derived_moving, a SEPARATE column from `moving`.
//
// Before writing anything, sweeps a few speed thresholds against every run
// that DOES have Strava's real flag (the ground-truth subset) and reports
// per-sample accuracy + per-confirmed-stop precision/recall for each —
// validating the heuristic against real data instead of just asserting it.
//
//   pnpm dm:backfill            DRY RUN — calibrate + compute + print, no writes
//   pnpm dm:backfill --write    upsert derived_moving for every stream
//
// Idempotent: re-running recomputes + overwrites derived_moving in place.

const CANDIDATE_THRESHOLDS_MPS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0, 1.2];

function parseArgs(argv: string[]): { write: boolean } {
  return { write: argv.includes('--write') };
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—';
}

async function main(): Promise<void> {
  loadEnv();
  const { write } = parseArgs(process.argv.slice(2));
  logger.info('starting derived-moving backfill', { job: 'derived-moving', write });

  const streams = await loadDistanceStreams();
  const groundTruth = streams.filter((s) => s.moving && s.moving.length === s.timeS.length);

  const out: string[] = [];
  out.push('');
  out.push(
    `Distance-bearing streams: ${streams.length}  (${groundTruth.length} with real Strava moving data)`,
  );
  out.push('');
  out.push(`Threshold sweep vs Strava ground truth (aggregated across all ${groundTruth.length} ground-truth runs):`);
  out.push('  m/s   sample-acc   stop-recall   stop-precision   f1     real-stops  derived-stops');

  let best: { threshold: number; f1: number } | null = null;
  for (const threshold of CANDIDATE_THRESHOLDS_MPS) {
    let tp = 0;
    let tn = 0;
    let fp = 0;
    let fn = 0;
    let realStops = 0;
    let derivedStops = 0;
    let matchedReal = 0;
    let matchedDerived = 0;

    for (const s of groundTruth) {
      const derived = deriveMovingFlags(s.timeS, s.distanceM, { stopSpeedMps: threshold });
      if (!derived) continue;
      const cmp = compareMovingFlags(derived, s.moving!);
      if (cmp) {
        tp += cmp.truePositive;
        tn += cmp.trueNegative;
        fp += cmp.falsePositive;
        fn += cmp.falseNegative;
      }
      const stopCmp = compareConfirmedStops(s.timeS, derived, s.moving!);
      realStops += stopCmp.realStops;
      derivedStops += stopCmp.derivedStops;
      matchedReal += stopCmp.matchedReal;
      matchedDerived += stopCmp.matchedDerived;
    }

    const total = tp + tn + fp + fn;
    const recall = realStops > 0 ? matchedReal / realStops : 0;
    const precision = derivedStops > 0 ? matchedDerived / derivedStops : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    if (!best || f1 > best.f1) best = { threshold, f1 };

    out.push(
      `  ${threshold.toFixed(1).padStart(4)}  ${pct(tp + tn, total).padStart(10)}   ` +
        `${pct(matchedReal, realStops).padStart(11)}   ${pct(matchedDerived, derivedStops).padStart(14)}   ` +
        `${f1.toFixed(2).padStart(4)}   ${String(realStops).padStart(10)}  ${String(derivedStops).padStart(13)}`,
    );
  }
  out.push('');
  out.push(
    `Best stop-level F1: ${best!.threshold} m/s (library default is ${DEFAULT_STOP_SPEED_MPS} m/s).`,
  );

  // Backfill pass: derive + write for EVERY distance-bearing stream (not just
  // the ground-truth subset), using the library default threshold.
  let written = 0;
  let skipped = 0;
  for (const s of streams) {
    const derived = deriveMovingFlags(s.timeS, s.distanceM);
    if (!derived) {
      skipped++;
      continue;
    }
    if (write) await updateDerivedMoving(s.runId, s.source as StreamSource, derived);
    written++;
  }

  out.push('');
  out.push(
    write
      ? `WROTE derived_moving for ${written} stream(s) (${skipped} skipped — too short) at ${DEFAULT_STOP_SPEED_MPS} m/s.`
      : `DRY RUN — would write derived_moving for ${written} stream(s) (${skipped} skipped) at ${DEFAULT_STOP_SPEED_MPS} m/s. Re-run with --write to persist.`,
  );
  out.push('');
  // eslint-disable-next-line no-console
  console.log(out.join('\n') + '\n');
}

main()
  .catch((err) => {
    logger.error('derived-moving backfill failed', { job: 'derived-moving' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
