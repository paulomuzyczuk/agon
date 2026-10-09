import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import { getAthleteProfile } from '../lib/athleteProfile';
import {
  loadDeviceWattsStreams,
  scoreRidePower,
  upsertRidePowerMetrics,
  type DeviceWattsStream,
  type RidePowerMetricsRow,
} from '../services/ridePowerMetrics';

// Backfill Agon's ride power metrics (MZY-269): NP / IF / TSS and the
// mean-maximal curve, from DEVICE-measured watts streams only (estimated
// Strava watts are never read — services/ridePowerMetrics.ts). IF/TSS use
// the FTP in force on each ride date (athlete profile `ftpHistory`); without
// one they stay empty. TSS never feeds training load, so no tl:backfill
// follow-up is needed.
//
//   pnpm power:backfill-metrics            DRY RUN — compute + print, no writes
//   pnpm power:backfill-metrics --write    upsert ride_power_metrics + curve
//
// Idempotent (ride_id PK, curve replaced wholesale). Until a power meter
// exists this finds 0 device streams — that is the expected answer.

function parseArgs(argv: string[]): { write: boolean } {
  for (const arg of argv) {
    if (arg !== '--write') {
      throw new Error(`backfill-ride-power-metrics: unknown option '${arg}'`);
    }
  }
  return { write: argv.includes('--write') };
}

const show = (v: number | null): string => (v === null ? '—' : String(v));

async function main(): Promise<void> {
  loadEnv();
  const { write } = parseArgs(process.argv.slice(2));
  const { ftpHistory } = getAthleteProfile();
  logger.info('starting ride power-metrics backfill', {
    job: 'ride-power-metrics',
    write,
    ftpEntries: ftpHistory?.length ?? 0,
  });

  const byRide = new Map<string, DeviceWattsStream[]>();
  for (const s of await loadDeviceWattsStreams()) {
    const arr = byRide.get(s.rideId) ?? [];
    arr.push(s);
    byRide.set(s.rideId, arr);
  }

  const scored: Array<RidePowerMetricsRow & { date: string }> = [];
  let skipped = 0;
  for (const streams of byRide.values()) {
    const row = scoreRidePower(streams, ftpHistory);
    if (!row) {
      skipped++;
      continue;
    }
    scored.push({ ...row, date: streams[0]!.date });
    if (write) await upsertRidePowerMetrics(row);
  }

  const out: string[] = [''];
  out.push(`Rides with device watts:  ${byRide.size}`);
  out.push(`  scored:                 ${scored.length}`);
  out.push(`  skipped (too short):    ${skipped}`);
  out.push(
    `FTP history entries:      ${ftpHistory?.length ?? 0}` +
      (ftpHistory?.length ? '' : '  (IF/TSS not computed)'),
  );
  if (scored.length > 0) {
    out.push('');
    out.push('Power metrics per ride (most recent 15):');
    out.push('  date        NP W   IF     TSS    FTP   src');
    for (const s of scored.slice(-15).reverse()) {
      out.push(
        `  ${s.date}  ${String(s.npW).padStart(4)}  ${show(s.intensityFactor).padEnd(5)}  ` +
          `${show(s.tss).padStart(5)}  ${show(s.ftpW).padStart(4)}  ${s.streamSource}`,
      );
    }
  }
  out.push('');
  out.push(
    write
      ? `WROTE ${scored.length} row(s) to public.ride_power_metrics (+ curve).`
      : 'DRY RUN — no changes written. Re-run with --write to persist.',
  );
  // eslint-disable-next-line no-console
  console.log(out.join('\n') + '\n');
}

main()
  .catch((err) => {
    logger.error(
      'ride power-metrics backfill failed',
      { job: 'ride-power-metrics' },
      err,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
