import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import { computeTrainingLoad } from '../lib/trainingLoad';
import {
  loadDailyRelativeEffort,
  upsertTrainingLoadDay,
  TRAINING_LOAD_PARAMS,
} from '../services/trainingLoad';

// Backfill daily training load (Banister CTL/ATL/TSB, Premium-Parity "Fitness &
// Freshness"). Sums per-run + per-ride Relative Effort per day, then rolls the
// three EWMAs forward over a continuous date spine (rest days = 0) through --end
// (default today). Pure math is in lib/trainingLoad.ts. Run `pnpm re:backfill
// --write` and `pnpm re:backfill-rides --write` first so both scores exist.
//
//   pnpm tl:backfill                 DRY RUN — compute + print, no writes
//   pnpm tl:backfill --write         upsert into public.training_load_daily
//   pnpm tl:backfill --end=2026-08-05    stop the spine on a given day
//
// Idempotent (date PK): re-running recomputes + overwrites each day.

const PARAMS = TRAINING_LOAD_PARAMS;

// Captured Strava web reference (2026-08-05) for the shape/sign sanity check —
// see docs/strava-benchmark.md + analytics/seeds/strava_web_reference.csv.
// Different unit scale (Relative-Effort based), so compare SIGN + SHAPE, not
// absolute magnitude.
const REFERENCE = { date: '2026-08-05', ctl: 38, atl: 69, tsb: -31 };

function parseArgs(argv: string[]): { write: boolean; end?: string } {
  const end = argv.find((a) => a.startsWith('--end='))?.slice('--end='.length);
  return { write: argv.includes('--write'), end };
}

/** Today (athlete-local ~ UTC date is close enough for a daily spine endpoint). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  loadEnv();
  const { write, end } = parseArgs(process.argv.slice(2));
  const spineEnd = end ?? today();
  logger.info('starting training-load backfill', {
    job: 'training-load',
    write,
    end: spineEnd,
    params: PARAMS,
  });

  const daily = await loadDailyRelativeEffort();
  if (daily.length === 0) {
    logger.warn('no scored runs or rides — nothing to compute', {
      job: 'training-load',
    });
    // eslint-disable-next-line no-console
    console.log(
      '\nNo run_relative_effort/ride_relative_effort rows. Run `pnpm re:backfill --write` ' +
        '(and `pnpm re:backfill-rides --write`) first.\n',
    );
    return;
  }

  const series = computeTrainingLoad(daily, { ...PARAMS, end: spineEnd });

  if (write) {
    for (const day of series) await upsertTrainingLoadDay(day, PARAMS);
  }

  const out: string[] = [];
  const last = series[series.length - 1]!;
  out.push('');
  out.push(`Load days (with runs):  ${daily.length}`);
  out.push(`Spine:                  ${series[0]!.date} → ${last.date}  (${series.length} days)`);
  out.push(`Model:                  CTL ${PARAMS.ctlDays}d / ATL ${PARAMS.atlDays}d / TSB ${PARAMS.tsbMode}`);
  out.push('');
  out.push('Last 14 days:');
  out.push('  date        load    CTL    ATL    TSB');
  for (const d of series.slice(-14)) {
    out.push(
      `  ${d.date}  ${d.load.toFixed(1).padStart(6)}  ${d.ctl.toFixed(1).padStart(5)}  ` +
        `${d.atl.toFixed(1).padStart(5)}  ${d.tsb.toFixed(1).padStart(6)}`,
    );
  }

  // Validation: compare the model on the reference capture date to Strava's
  // web numbers. Same sign + shape expected, NOT identical magnitude.
  const refRow = series.find((d) => d.date === REFERENCE.date);
  out.push('');
  out.push(`Validation vs Strava web reference (${REFERENCE.date}):`);
  out.push(`  Strava (RE-unit scale):  CTL ${REFERENCE.ctl}   ATL ${REFERENCE.atl}   TSB ${REFERENCE.tsb}`);
  if (refRow) {
    out.push(`  Agon  (TRIMP-unit scale): CTL ${refRow.ctl}   ATL ${refRow.atl}   TSB ${refRow.tsb}`);
    const signOk = Math.sign(refRow.tsb) === Math.sign(REFERENCE.tsb);
    const shapeOk = refRow.atl > refRow.ctl; // fatigued: acute above chronic
    out.push(
      `  → TSB sign match: ${signOk ? 'YES' : 'NO'} (both ${REFERENCE.tsb < 0 ? 'negative = fatigued' : 'positive'}); ` +
        `ATL>CTL (fatigued shape): ${shapeOk ? 'YES' : 'NO'}`,
    );
  } else {
    out.push(`  (reference date not in spine — pass --end=${REFERENCE.date} or a later date)`);
  }

  out.push('');
  out.push(
    write
      ? `WROTE ${series.length} day(s) to public.training_load_daily.`
      : 'DRY RUN — no changes written. Re-run with --write to persist.',
  );
  out.push('Next: build the fct_training_load_daily dbt mart.');
  out.push('');
  // eslint-disable-next-line no-console
  console.log(out.join('\n') + '\n');
}

main()
  .catch((err) => {
    logger.error('training-load backfill failed', { job: 'training-load' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
