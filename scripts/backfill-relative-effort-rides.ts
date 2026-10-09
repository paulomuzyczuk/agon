import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import { getAthleteProfile } from '../lib/athleteProfile';
import {
  loadScorableRides,
  loadRideHrStreams,
  scoreRide,
  upsertRideRelativeEffort,
  type RideHrStreamRow,
  type RideRelativeEffortRow,
} from '../services/relativeEffortRides';

// Backfill Relative Effort (per-ride Banister TRIMP) for every ride with
// heart-rate data. Sibling to scripts/backfill-relative-effort.ts (rides vs.
// runs). Prefers the richest HR stream integrated sample-by-sample; falls
// back to a ride's average HR when no usable stream exists. No pace→HR
// surrogate tier (see migrations/20260910040000_ride_relative_effort.sql) —
// a ride with neither a stream nor an average HR stays unscored.
//
//   pnpm re:backfill-rides            DRY RUN — compute + print, no writes
//   pnpm re:backfill-rides --write    upsert into public.ride_relative_effort
//
// Idempotent (ride_id PK): re-running recomputes + overwrites each score.

const profile = getAthleteProfile();
const anchors = { hrRest: profile.hrRest, hrMax: profile.hrMax };

function parseArgs(argv: string[]): { write: boolean } {
  return { write: argv.includes('--write') };
}

async function main(): Promise<void> {
  loadEnv();
  const { write } = parseArgs(process.argv.slice(2));
  logger.info('starting ride relative-effort backfill', {
    job: 'ride-relative-effort',
    write,
    anchors,
  });

  const rides = await loadScorableRides();
  const streamsByRide = new Map<string, RideHrStreamRow[]>();
  for (const s of await loadRideHrStreams()) {
    const arr = streamsByRide.get(s.rideId) ?? [];
    arr.push(s);
    streamsByRide.set(s.rideId, arr);
  }

  const scored: Array<
    RideRelativeEffortRow & { date: string; distanceKm: number }
  > = [];
  let skipped = 0;
  for (const ride of rides) {
    const row = scoreRide(ride, streamsByRide.get(ride.rideId) ?? [], anchors);
    if (!row) {
      skipped++;
      continue;
    }
    scored.push({ ...row, date: ride.date, distanceKm: ride.distanceKm });
    if (write) await upsertRideRelativeEffort(row);
  }

  const out: string[] = [];
  const nStream = scored.filter((s) => s.method === 'stream').length;
  const nAvg = scored.filter((s) => s.method === 'average').length;
  out.push('');
  out.push(`Scorable rides:       ${rides.length}`);
  out.push(
    `  scored:             ${scored.length}  (${nStream} stream, ${nAvg} avg-HR)`,
  );
  out.push(`  skipped (no HR):    ${skipped}`);
  out.push(
    `HR anchors:           rest ${anchors.hrRest} / max ${anchors.hrMax} bpm`,
  );
  out.push('');
  out.push('Relative Effort per ride (most recent 15):');
  out.push('  date        dist    RE     method    src');
  for (const s of scored.slice(-15).reverse()) {
    out.push(
      `  ${s.date}  ${s.distanceKm.toFixed(1).padStart(5)}km  ${String(s.score).padStart(6)}  ` +
        `${s.method.padEnd(9)} ${s.streamSource ?? '-'}`,
    );
  }
  out.push('');
  out.push(
    write
      ? `WROTE ${scored.length} relative-effort row(s) to public.ride_relative_effort.`
      : 'DRY RUN — no changes written. Re-run with --write to persist.',
  );
  out.push(
    'Next: pnpm tl:backfill --write to fold ride load into training_load_daily.',
  );
  out.push('');
  // eslint-disable-next-line no-console
  console.log(out.join('\n') + '\n');
}

main()
  .catch((err) => {
    logger.error(
      'ride relative-effort backfill failed',
      { job: 'ride-relative-effort' },
      err,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
