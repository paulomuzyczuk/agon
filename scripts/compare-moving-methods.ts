import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import {
  deriveMovingFlags,
  deriveMovingFlagsFromCadence,
  compareMovingFlags,
  compareConfirmedStops,
  DEFAULT_STOP_SPEED_MPS,
  DEFAULT_STOP_CADENCE_SPM,
  DEFAULT_STOP_FITBIT_CADENCE_SPM,
} from '../lib/movingTime';
import { loadDistanceStreams } from '../services/bestEfforts';

// Compares two INDEPENDENTLY-derived moving-flag methods against each other
// and against Strava's real flag: the existing speed-threshold method
// (distance/time — ultimately the same GPS signal Strava's own algorithm
// works from) vs. a cadence-threshold method (accelerometer stride rate,
// mechanically unrelated to GPS at all, thresholded from cadence's own value
// distribution — never tuned to match Strava). Agreement between the two
// independent methods is stronger evidence of correctness than either one
// matching Strava, since Strava's flag is confirmed noisy and both other
// methods could just be agreeing with its noise instead of with reality.
//
// Read-only report — writes nothing. Restricted to the (currently small)
// subset of streams carrying BOTH real Strava `moving` AND cadence data.
//
//   pnpm mv:compare

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—';
}

interface Totals {
  tp: number;
  tn: number;
  fp: number;
  fn: number;
  aStops: number;
  bStops: number;
  matchedA: number;
  matchedB: number;
}

function emptyTotals(): Totals {
  return { tp: 0, tn: 0, fp: 0, fn: 0, aStops: 0, bStops: 0, matchedA: 0, matchedB: 0 };
}

function accumulate(
  totals: Totals,
  timeS: number[],
  a: Array<boolean | null>,
  b: Array<boolean | null>,
): void {
  const cmp = compareMovingFlags(a, b);
  if (cmp) {
    totals.tp += cmp.truePositive;
    totals.tn += cmp.trueNegative;
    totals.fp += cmp.falsePositive;
    totals.fn += cmp.falseNegative;
  }
  const stopCmp = compareConfirmedStops(timeS, a, b);
  totals.aStops += stopCmp.derivedStops; // 'a' plays the "derived" role in compareConfirmedStops
  totals.bStops += stopCmp.realStops; // 'b' plays the "real" role
  totals.matchedA += stopCmp.matchedDerived;
  totals.matchedB += stopCmp.matchedReal;
}

function printRow(label: string, t: Totals): string {
  const total = t.tp + t.tn + t.fp + t.fn;
  const sampleAcc = pct(t.tp + t.tn, total);
  const recall = pct(t.matchedB, t.bStops); // b's stops found by a
  const precision = pct(t.matchedA, t.aStops); // a's stops confirmed by b
  return (
    `  ${label.padEnd(28)} sample-agree ${sampleAcc.padStart(6)}   ` +
    `stops: a=${String(t.aStops).padStart(3)} b=${String(t.bStops).padStart(3)}   ` +
    `a-found-in-b ${precision.padStart(6)}   b-found-in-a ${recall.padStart(6)}`
  );
}

async function main(): Promise<void> {
  loadEnv();
  logger.info('comparing moving-flag methods', { job: 'compare-moving-methods' });

  const streams = await loadDistanceStreams();
  const withCadence = streams.filter(
    (s) => s.cadence && s.cadence.length === s.timeS.length,
  );
  const withFitbitCadence = streams.filter(
    (s) => s.fitbitCadence && s.fitbitCadence.length === s.timeS.length,
  );
  const withBoth = withCadence.filter((s) => s.moving && s.moving.length === s.timeS.length);
  const withFitbitAndReal = withFitbitCadence.filter(
    (s) => s.moving && s.moving.length === s.timeS.length,
  );
  const withAllThree = withFitbitAndReal.filter(
    (s) => s.cadence && s.cadence.length === s.timeS.length,
  );

  const out: string[] = [];
  out.push('');
  out.push(`Distance-bearing streams: ${streams.length}`);
  out.push(`  with phone cadence data:         ${withCadence.length}`);
  out.push(`  with Fitbit-wrist cadence data:  ${withFitbitCadence.length}`);
  out.push(`  with phone cadence AND real Strava moving:  ${withBoth.length}`);
  out.push(`  with Fitbit cadence AND real Strava moving: ${withFitbitAndReal.length}`);
  out.push(`  with all three (phone + Fitbit + Strava):   ${withAllThree.length}`);
  out.push('');
  out.push(
    `Speed threshold: ${DEFAULT_STOP_SPEED_MPS} m/s (calibrated vs. Strava — see docs/methodology-log.md). ` +
      `Phone cadence threshold: ${DEFAULT_STOP_CADENCE_SPM} spm (one-foot convention, from phone cadence's OWN distribution). ` +
      `Fitbit-wrist cadence threshold: ${DEFAULT_STOP_FITBIT_CADENCE_SPM} spm (both-feet convention, from Fitbit cadence's OWN distribution).`,
  );
  out.push('');

  if (withBoth.length === 0) {
    out.push('No streams have both cadence and real Strava moving data — nothing to compare yet.');
  } else {
    const speedVsStrava = emptyTotals();
    const cadenceVsStrava = emptyTotals();
    const speedVsCadence = emptyTotals();

    for (const s of withBoth) {
      const speed = deriveMovingFlags(s.timeS, s.distanceM);
      const cadence = deriveMovingFlagsFromCadence(s.timeS, s.cadence!);
      if (!speed || !cadence) continue;
      accumulate(speedVsStrava, s.timeS, speed, s.moving!);
      accumulate(cadenceVsStrava, s.timeS, cadence, s.moving!);
      accumulate(speedVsCadence, s.timeS, speed, cadence);
    }

    out.push(`Per-run comparisons (phone cadence), aggregated across ${withBoth.length} run(s):`);
    out.push('  (a-found-in-b = precision of a vs b; b-found-in-a = recall of a vs b)');
    out.push(printRow('speed vs. Strava', speedVsStrava));
    out.push(printRow('phone-cadence vs. Strava', cadenceVsStrava));
    out.push(printRow('speed vs. phone-cadence (independent)', speedVsCadence));
  }

  out.push('');

  if (withFitbitAndReal.length === 0) {
    out.push('No streams have both Fitbit-wrist cadence and real Strava moving data — nothing to compare yet.');
  } else {
    const speedVsStrava = emptyTotals();
    const fitbitVsStrava = emptyTotals();
    const speedVsFitbit = emptyTotals();
    const fitbitVsPhone = emptyTotals();

    for (const s of withFitbitAndReal) {
      const speed = deriveMovingFlags(s.timeS, s.distanceM);
      const fitbit = deriveMovingFlagsFromCadence(s.timeS, s.fitbitCadence!, {
        stopCadenceSpm: DEFAULT_STOP_FITBIT_CADENCE_SPM,
      });
      if (!speed || !fitbit) continue;
      accumulate(speedVsStrava, s.timeS, speed, s.moving!);
      accumulate(fitbitVsStrava, s.timeS, fitbit, s.moving!);
      accumulate(speedVsFitbit, s.timeS, speed, fitbit);

      if (s.cadence && s.cadence.length === s.timeS.length) {
        const phone = deriveMovingFlagsFromCadence(s.timeS, s.cadence);
        if (phone) accumulate(fitbitVsPhone, s.timeS, fitbit, phone);
      }
    }

    out.push(`Per-run comparisons (Fitbit-wrist cadence), aggregated across ${withFitbitAndReal.length} run(s):`);
    out.push('  (a-found-in-b = precision of a vs b; b-found-in-a = recall of a vs b)');
    out.push(printRow('speed vs. Strava', speedVsStrava));
    out.push(printRow('fitbit-cadence vs. Strava', fitbitVsStrava));
    out.push(printRow('speed vs. fitbit-cadence (independent)', speedVsFitbit));
    if (withAllThree.length > 0) {
      out.push(printRow('fitbit-cadence vs. phone-cadence', fitbitVsPhone));
    }
    out.push('');
    out.push(
      'speed-vs-fitbit-cadence is the row that answers the "is the phone the noise source" question: ' +
        'if the wrist sensor agrees with GPS-speed MORE than the phone did (91.8%), that corroborates ' +
        'the phone-signal-noise hypothesis; if it agrees LESS or similarly, the earlier recall gap is ' +
        'more likely a genuine definitional difference (or a coverage/granularity artifact — see ' +
        'docs/methodology-log.md for the Fitbit-wrist coverage and 1-minute-bucket-resolution caveats).',
    );
  }

  out.push('');
  out.push(
    'Caveat (phone cadence): comes from a cellphone carried during the run, not a wrist/foot sensor — ' +
      "loosely coupled to actual stride motion. Caveat (Fitbit-wrist cadence): native to Google Health's " +
      '1-minute buckets (far coarser than the ~1 Hz GPS/HR sample rate) and had usable (>=50%) coverage on ' +
      'only a minority of runs in this dataset — the wrist device has NO steps data at all before ' +
      '2026-07-01, and coverage is bimodal even after that (mostly-complete or near-zero per run, rarely ' +
      'in between). See docs/methodology-log.md for the full discussion.',
  );

  out.push('');
  // eslint-disable-next-line no-console
  console.log(out.join('\n') + '\n');
}

main()
  .catch((err) => {
    logger.error('compare-moving-methods failed', { job: 'compare-moving-methods' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
