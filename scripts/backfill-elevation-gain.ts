import { loadEnv } from './loadEnv';
import { assertLocalTarget } from './seedGuard';
import { query, closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import { elevationGainM, HYSTERESIS_M } from '../lib/elevationGain';

// Backfill runs/rides.elevation_gain_m from the stored altitude stream
// (MZY-295, lib/elevationGain.ts) for every activity that has an
// altitude_m + distance_m stream but NO gain — e.g. a live recording
// flushed before MZY-295. An upstream gain (Strava, Google Health, a file
// export) is never overwritten: only NULL gains are written, re-checked in
// the UPDATE itself.
//
// Before writing, it re-runs the calibration behind HYSTERESIS_M: our gain
// vs the upstream one on every activity that has both, with and without the
// band — so the choice stays checkable as data accumulates.
//
//   pnpm elevation:backfill            DRY RUN — calibrate + compute + print
//   pnpm elevation:backfill --write    write the NULL gains
//
// Refuses a non-local DATABASE_URL unless ALLOW_REMOTE_SEED=1 (seedGuard).
// Idempotent: a written gain is no longer NULL, so a re-run skips it.

type Kind = 'run' | 'ride';

interface Row {
  id: string;
  source: string;
  stream_source: string;
  gain: string | null;
  distance_m: Array<string | null>;
  altitude_m: Array<string | null>;
}

const TABLES: Record<Kind, { table: string; streams: string; fk: string }> = {
  run: { table: 'runs', streams: 'run_streams', fk: 'run_id' },
  ride: { table: 'rides', streams: 'ride_streams', fk: 'ride_id' },
};

/** One stream per activity: its own source's first, else any with altitude. */
async function load(kind: Kind): Promise<Row[]> {
  const { table, streams, fk } = TABLES[kind];
  const { rows } = await query<Row>(
    `SELECT DISTINCT ON (a.id)
            a.id, a.source, s.source AS stream_source,
            a.elevation_gain_m AS gain, s.distance_m, s.altitude_m
       FROM public.${table} a
       JOIN public.${streams} s ON s.${fk} = a.id
      WHERE s.altitude_m IS NOT NULL AND s.distance_m IS NOT NULL
      ORDER BY a.id, (s.source = a.source) DESC, s.source`,
  );
  return rows;
}

const num = (xs: Array<string | null>) =>
  xs.map((v) => (v == null ? null : Number(v)));

function quantile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.round(p * (s.length - 1))] ?? NaN;
}

function calibrate(rows: Row[], out: string[]): void {
  const truth = rows.filter((r) => r.gain != null && Number(r.gain) > 0);
  out.push(
    `Calibration vs upstream gain (${truth.length} activities; error = ours − upstream):`,
  );
  out.push('  band m   median bias   median |err|   p90 |err|   within 15 %');
  for (const band of [0, 0.25, HYSTERESIS_M, 1, 3]) {
    const pct: number[] = [];
    for (const r of truth) {
      const up = Number(r.gain);
      const ours =
        elevationGainM(num(r.distance_m), num(r.altitude_m), {
          hysteresisM: band,
        }) ?? 0;
      pct.push(((ours - up) / up) * 100);
    }
    const abs = pct.map(Math.abs);
    out.push(
      `  ${band.toFixed(2).padStart(6)}${band === HYSTERESIS_M ? '*' : ' '}` +
        `${quantile(pct, 0.5).toFixed(1).padStart(12)} %` +
        `${quantile(abs, 0.5).toFixed(1).padStart(12)} %` +
        `${quantile(abs, 0.9).toFixed(1).padStart(10)} %` +
        `${String(abs.filter((e) => e <= 15).length).padStart(9)}/${truth.length}`,
    );
  }
  out.push(`  (* = HYSTERESIS_M, what the flush and this backfill use)`);
}

async function main(): Promise<void> {
  loadEnv();
  assertLocalTarget('backfill-elevation-gain');
  const write = process.argv.slice(2).includes('--write');
  logger.info('starting elevation-gain backfill', {
    job: 'elevation-gain',
    write,
  });

  const out: string[] = [''];
  for (const kind of ['run', 'ride'] as const) {
    const rows = await load(kind);
    out.push(`== ${kind}s with an altitude stream: ${rows.length} ==`);
    calibrate(rows, out);

    let written = 0;
    let tooShort = 0;
    for (const r of rows.filter((x) => x.gain == null)) {
      const gain = elevationGainM(num(r.distance_m), num(r.altitude_m));
      if (gain == null) {
        tooShort++;
        continue;
      }
      out.push(`  ${r.id} (${r.source}, stream ${r.stream_source}): ${gain} m`);
      if (write) {
        const { rowCount } = await query(
          `UPDATE public.${TABLES[kind].table}
              SET elevation_gain_m = $2
            WHERE id = $1 AND elevation_gain_m IS NULL`,
          [r.id, gain],
        );
        written += rowCount ?? 0;
      } else {
        written++;
      }
    }
    out.push(
      write
        ? `WROTE elevation_gain_m for ${written} ${kind}(s); ${tooShort} too short.`
        : `DRY RUN — would write ${written} ${kind}(s); ${tooShort} too short. Re-run with --write.`,
    );
    out.push('');
  }
  // eslint-disable-next-line no-console
  console.log(out.join('\n'));
}

main()
  .catch((err) => {
    logger.error(
      'elevation-gain backfill failed',
      { job: 'elevation-gain' },
      err,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
