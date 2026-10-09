import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import { getAthleteProfile } from '../lib/athleteProfile';
import type { FuelingActivity } from '../lib/fuelingModel';
import { getBaselineSweatRate } from '../services/sweat';
import {
  fuelingRowFor,
  loadFuelingCandidates,
  upsertFuelingBalance,
  type FuelingBalanceRow,
} from '../services/fuelingBalance';

// Backfill the fueling & hydration balance (lib/fuelingModel.ts) for every run
// and ride ≥ 60 min or with logged intake (MZY-64). The sweat-rate baseline is
// the CURRENT one (latest /sweat observation, else the profile) — re-running
// after a new weigh-in recomputes history against the better-calibrated rate.
//
//   pnpm fueling:backfill            DRY RUN — compute + print, no writes
//   pnpm fueling:backfill --write    upsert run_/ride_fueling_balance
//
// Idempotent (activity-id PK): re-running recomputes + overwrites each row.

const ACTIVITIES: FuelingActivity[] = ['run', 'ride'];

function parseArgs(argv: string[]): { write: boolean } {
  return { write: argv.includes('--write') };
}

const flag = (v: boolean | null): string => (v == null ? '?' : v ? 'Y' : '-');

async function main(): Promise<void> {
  loadEnv();
  const { write } = parseArgs(process.argv.slice(2));
  const profile = getAthleteProfile();
  const baseline = await getBaselineSweatRate();
  logger.info('starting fueling-balance backfill', {
    job: 'fueling-balance',
    write,
    baselineSweatRateLPerH: baseline,
  });

  const out: string[] = [''];
  out.push(`Baseline sweat rate:  ${baseline} L/h`);
  out.push(`Sweat sodium:         ${profile.sweatSodiumMgPerL} mg/L`);
  let written = 0;

  for (const activity of ACTIVITIES) {
    const candidates = await loadFuelingCandidates(activity);
    const rows: Array<
      FuelingBalanceRow & { date: string; distanceKm: number }
    > = [];
    for (const c of candidates) {
      const row = fuelingRowFor(c, profile, baseline);
      rows.push({ ...row, date: c.date, distanceKm: c.distanceKm });
      if (write) await upsertFuelingBalance(activity, row);
    }
    written += write ? rows.length : 0;

    const logged = rows.filter((r) => r.balance.intakeLogged).length;
    out.push('');
    out.push(
      `${activity}s modelled: ${rows.length}  (${logged} with logged intake)`,
    );
    out.push(
      '  date        dist     h    loss L  fluid L  mass%  carbs/h  dehyd  under',
    );
    for (const r of rows.slice(-10).reverse()) {
      const b = r.balance;
      out.push(
        `  ${r.date}  ${r.distanceKm.toFixed(1).padStart(5)}km  ` +
          `${(r.durationS / 3600).toFixed(1).padStart(4)}  ` +
          `${b.estSweatLossL.toFixed(2).padStart(6)}  ` +
          `${(b.fluidIntakeL?.toFixed(2) ?? '-').padStart(7)}  ` +
          `${(b.bodyMassLossPct?.toFixed(1) ?? '-').padStart(5)}  ` +
          `${(b.carbsPerH?.toFixed(0) ?? '-').padStart(7)}  ` +
          `${flag(b.dehydrated).padStart(5)}  ${flag(b.underFueled).padStart(5)}`,
      );
    }
  }

  out.push('');
  out.push(
    write
      ? `WROTE ${written} fueling-balance row(s).`
      : 'DRY RUN — no changes written. Re-run with --write to persist.',
  );
  out.push('');
  // eslint-disable-next-line no-console
  console.log(out.join('\n') + '\n');
}

main()
  .catch((err) => {
    logger.error(
      'fueling-balance backfill failed',
      { job: 'fueling-balance' },
      err,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
