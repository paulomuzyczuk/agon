import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import { backfillRidePower } from '../services/strava/ridePowerBackfill';

// Re-pull power for rides already stored from Strava (MZY-267). See
// services/strava/ridePowerBackfill.ts for the full rationale.
//
//   pnpm power:backfill-rides                     dry run: print every change
//   pnpm power:backfill-rides --write             apply them
//   pnpm power:backfill-rides --probe-streams     also fetch streams for rides
//                                                 WITHOUT a meter (one call
//                                                 each) to see whether Strava
//                                                 serves estimated watts
//
// Writes only the power columns and the watts series; hand corrections win.
// Idempotent and resumable after a rate-limit stop. A REAL ingestion job —
// it deliberately does NOT use the seed guard.

function parseArgs(argv: string[]): { write: boolean; probeStreams: boolean } {
  const known = new Set(['--write', '--probe-streams']);
  for (const arg of argv) {
    if (!known.has(arg)) {
      throw new Error(`backfill-ride-power: unknown option '${arg}'`);
    }
  }
  return {
    write: argv.includes('--write'),
    probeStreams: argv.includes('--probe-streams'),
  };
}

const show = (v: number | string | null): string =>
  v === null ? '—' : String(v);

async function main(): Promise<void> {
  loadEnv();
  const opts = parseArgs(process.argv.slice(2));
  const s = await backfillRidePower(opts);

  const out: string[] = [];
  out.push(
    `\nRide power backfill (${s.write ? 'WRITE' : 'dry run'}): ` +
      `${s.ridesMatched}/${s.ridesStored} stored Strava rides matched, ` +
      `${s.ridesChanged} with power changes, ` +
      `${s.ridesSkippedCorrected} skipped (power hand-corrected), ` +
      `${s.pagesFetched} list page(s).`,
  );
  for (const c of s.changes) {
    out.push(`  ${c.date}  ride ${c.rideId} (strava ${c.externalId})`);
    for (const ch of c.changes) {
      out.push(`      ${ch.field}: ${show(ch.from)} → ${show(ch.to)}`);
    }
  }
  if (s.streams.length > 0) {
    out.push('  Streams:');
    for (const st of s.streams) {
      out.push(
        `    ${st.date}  ride ${st.rideId}  meter=${st.deviceWatts ? 'yes' : 'no'}` +
          `  watts stream=${st.hasWatts ? 'yes' : 'no'}` +
          (st.stored ? `  → ${st.stored}` : ''),
      );
    }
  }
  if (s.write)
    out.push(`  Derived recomputed for ${s.derivedRecomputed} ride(s).`);
  if (s.rateLimited) out.push('  STOPPED on rate limit — re-run to resume.');
  if (!s.write && s.ridesChanged > 0)
    out.push('  Re-run with --write to apply.');
  // eslint-disable-next-line no-console
  console.log(out.join('\n') + '\n');
}

main()
  .catch((err) => {
    logger.error('ride power backfill failed', {
      job: 'ride-power-backfill',
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
