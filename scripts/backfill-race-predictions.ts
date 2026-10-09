import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import { getAthleteProfile } from '../lib/athleteProfile';
import { predictRaces } from '../lib/racePrediction';
import {
  loadBestEffortPairs,
  upsertRacePrediction,
} from '../services/racePrediction';

// Backfill race-time predictions (Premium-Parity #2) from the athlete's own
// best-effort pairs: a self-calibrated Riegel power law (personalized exponent)
// plus a Daniels VDOT cross-check. Pure models are in lib/racePrediction.ts.
//
//   pnpm rp:backfill            DRY RUN — compute + print, no writes
//   pnpm rp:backfill --write    upsert into public.race_predictions
//
// Idempotent (label PK): re-running recomputes + overwrites each row.

function parseArgs(argv: string[]): { write: boolean } {
  return { write: argv.includes('--write') };
}

/** Seconds → h:mm:ss / mm:ss. */
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
  logger.info('starting race-prediction backfill', { job: 'race-prediction', write });

  const pairs = await loadBestEffortPairs();
  if (pairs.length === 0) {
    logger.warn('no best-effort pairs', { job: 'race-prediction' });
    // eslint-disable-next-line no-console
    console.log('\nNo run_best_efforts rows. Run `pnpm be:backfill --write` first.\n');
    return;
  }

  const { fit, vdotRef, predictions } = predictRaces(pairs);
  if (!fit) {
    logger.warn('no usable pairs to fit', { job: 'race-prediction' });
    return;
  }

  if (write) {
    for (const p of predictions) await upsertRacePrediction(p, fit, vdotRef);
  }

  const out: string[] = [];
  out.push('');
  out.push(`Best-effort pairs:   ${fit.n}`);
  out.push(
    `Riegel fit:          k = ${fit.k.toFixed(3)}` +
      `${fit.fallback ? ' (generic fallback)' : ''}` +
      `   R² = ${fit.r2.toFixed(3)}   (generic reference k = 1.06)`,
  );
  out.push(
    `  → the fitted k ${fit.k > 1.06 ? 'exceeds' : 'is below'} the generic 1.06: this athlete's pace ` +
      `${fit.k > 1.06 ? 'fades faster' : 'holds better'} over distance than average.`,
  );
  if (vdotRef) {
    out.push(
      `Reference VDOT:       ${vdotRef.vdot.toFixed(1)}  ` +
        `(from ${Math.round(vdotRef.from.distanceM)} m in ${fmt(vdotRef.from.timeS)})`,
    );
    // Optional ceiling from the athlete profile (a measured or device-estimated
    // VO2max) to contrast the effort-derived VDOT against.
    const vo2max = getAthleteProfile().vo2maxMeasured;
    if (vo2max !== undefined) {
      out.push(
        `  vs measured VO2max ${vo2max}: derived VDOT is ${
          vdotRef.vdot < vo2max ? 'lower' : 'higher'
        } — expected, because best efforts here are fastest splits WITHIN training`,
      );
      out.push(
        `  runs, not all-out races. Predictions read as current sustained fitness, not race ceiling.`,
      );
    }
  }
  out.push('');
  out.push('Predicted times (headline = self-calibrated Riegel):');
  out.push('  distance        predicted   band            Riegel(1.06)   VDOT');
  for (const p of predictions) {
    const band = `${fmt(p.lowS)}–${fmt(p.highS)}`;
    out.push(
      `  ${p.label.padEnd(14)}  ${fmt(p.predictedS).padStart(8)}   ${band.padEnd(15)} ` +
        `${(p.riegelGenericS != null ? fmt(p.riegelGenericS) : '—').padStart(8)}      ` +
        `${p.vdotS != null ? fmt(p.vdotS) : '—'}` +
        `${p.extrapolated ? '   [extrapolated]' : ''}`,
    );
  }
  out.push('');
  out.push(
    '  Note: 70K is an extrapolation well beyond the longest best effort (Half). Riegel/VDOT',
  );
  out.push(
    '  degrade badly past the marathon (ultra performance is dominated by fueling, durability,',
  );
  out.push('  and terrain) — treat it as a rough band, never a single number.');
  out.push('');
  out.push(
    write
      ? `WROTE ${predictions.length} prediction(s) to public.race_predictions.`
      : 'DRY RUN — no changes written. Re-run with --write to persist.',
  );
  out.push('Next: build the fct_race_predictions dbt mart.');
  out.push('');
  // eslint-disable-next-line no-console
  console.log(out.join('\n') + '\n');
}

main()
  .catch((err) => {
    logger.error('race-prediction backfill failed', { job: 'race-prediction' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
