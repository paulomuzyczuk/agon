import { loadEnv } from './loadEnv';
import { closeDbPool, query } from '../services/db';
import { homeLocationOrNull } from '../services/routing/config';
import {
  DETECTION_PARAMS_BY_KIND,
  detectMissedStop,
  type DetectionParams,
  type MissedStopSuggestion,
} from '../lib/missedStopDetection';

// Backtest the missed-stop detector (MZY-254, lib/missedStopDetection.ts)
// over every stored GPS stream — runs and rides — and report how many
// activities each parameter set would flag. Read-only; prints no coordinates.
//
//   pnpm stops:backtest            per-kind default params + a small sweep
//   pnpm stops:backtest --list     also list every flagged activity and the
//                                  closest non-flagged tails (near misses)

interface Row {
  kind: 'run' | 'ride';
  id: string;
  date: string;
  source: string;
  stream_source: string;
  time_s: number[];
  lat: number[];
  lng: number[];
  distance_m: number[] | null;
  moving: boolean[] | null;
  distance_km: number;
  corrected: string[];
}

async function loadStreams(): Promise<Row[]> {
  const sql = (kind: 'run' | 'ride') => {
    const t = kind === 'run' ? 'runs' : 'rides';
    const st = kind === 'run' ? 'run_streams' : 'ride_streams';
    const fk = kind === 'run' ? 'run_id' : 'ride_id';
    // One GPS stream per activity: prefer one with moving flags, then the longest.
    return `SELECT DISTINCT ON (a.id) '${kind}' AS kind, a.id, a.date::text AS date,
                   a.source, s.source AS stream_source, s.time_s,
                   s.lat::float8[] AS lat, s.lng::float8[] AS lng,
                   s.distance_m::float8[] AS distance_m, s.moving,
                   a.distance_km::float8 AS distance_km, a.corrected_fields AS corrected
              FROM public.${t} a JOIN public.${st} s ON s.${fk} = a.id
             WHERE s.lat IS NOT NULL
             ORDER BY a.id, (s.moving IS NOT NULL) DESC, s.sample_count DESC`;
  };
  const runs = await query<Row>(sql('run'));
  const rides = await query<Row>(sql('ride'));
  return [...runs.rows, ...rides.rows].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
}

function run(
  rows: Row[],
  home: ReturnType<typeof homeLocationOrNull>,
  /** Adjusts the per-kind defaults (DETECTION_PARAMS_BY_KIND). */
  tweak: (p: DetectionParams) => DetectionParams = (p) => p,
): Array<{ row: Row; hit: MissedStopSuggestion }> {
  const out: Array<{ row: Row; hit: MissedStopSuggestion }> = [];
  for (const row of rows) {
    const hit = detectMissedStop(
      {
        timeS: row.time_s,
        lat: row.lat,
        lng: row.lng,
        distanceM: row.distance_m,
        moving: row.moving,
      },
      home,
      tweak(DETECTION_PARAMS_BY_KIND[row.kind]),
    );
    if (hit) out.push({ row, hit });
  }
  return out;
}

function summary(
  label: string,
  rows: Row[],
  hits: ReturnType<typeof run>,
): string {
  const by = (k: 'run' | 'ride', c: 'home' | 'away') =>
    hits.filter((h) => h.row.kind === k && h.hit.confidence === c).length;
  const n = (k: 'run' | 'ride') => rows.filter((r) => r.kind === k).length;
  return (
    `${label.padEnd(44)} runs ${String(by('run', 'home')).padStart(3)} home / ` +
    `${String(by('run', 'away')).padStart(3)} away of ${n('run')} · rides ` +
    `${String(by('ride', 'home')).padStart(3)} home / ${String(by('ride', 'away')).padStart(3)} away of ${n('ride')}`
  );
}

async function main(): Promise<void> {
  loadEnv();
  const list = process.argv.includes('--list');
  const home = homeLocationOrNull();
  const rows = await loadStreams();
  const out: string[] = [''];
  out.push(
    `GPS streams: ${rows.length}  (home ${home ? 'set' : 'NOT set — away-only'})`,
  );
  out.push('');

  type Tweak = (p: DetectionParams) => DetectionParams;
  const sweep: Array<[string, Tweak]> = [
    ['default (per kind)', (p) => p],
    ['minTail 120 s', (p) => ({ ...p, minTailS: 120 })],
    ['minTail 30 s', (p) => ({ ...p, minTailS: 30 })],
    ['home radius 50 m', (p) => ({ ...p, homeRadiusM: 50 })],
    ['home radius 150 m', (p) => ({ ...p, homeRadiusM: 150 })],
    ['away radius 30 m', (p) => ({ ...p, awayRadiusM: 30 })],
    ['tail speed < 0.5 m/s', (p) => ({ ...p, maxTailSpeedMps: 0.5 })],
    [
      'slow speed 2.0 m/s (runs too)',
      (p) => ({ ...p, slowSpeedMps: Math.max(p.slowSpeedMps, 2) }),
    ],
    ['slow speed 1.0 m/s (rides too)', (p) => ({ ...p, slowSpeedMps: 1 })],
  ];
  for (const [label, tweak] of sweep) {
    out.push(summary(label, rows, run(rows, home, tweak)));
  }

  const hits = run(rows, home);
  if (list) {
    out.push('');
    out.push('Flagged with default params:');
    out.push(
      '  date        kind  conf  src            trim     tail km  moving s  corrected',
    );
    for (const { row, hit } of hits) {
      out.push(
        `  ${row.date}  ${row.kind.padEnd(4)}  ${hit.confidence.padEnd(4)}  ` +
          `${row.stream_source.padEnd(13)}  ${`${(hit.trimS / 60).toFixed(1)}m`.padStart(6)}  ` +
          `${hit.distanceKm.toFixed(3).padStart(7)}  ${String(hit.movingS).padStart(8)}  ` +
          `${row.corrected.length > 0 ? 'yes' : ''}`,
      );
    }
  }
  if (list) {
    // Near misses: the same detector with the tail gates opened up, so every
    // slow tail shows — how far below the thresholds the negatives sit.
    const open: Tweak = (p) => ({
      ...p,
      minTailS: 1,
      maxTailSpeedMps: Number.POSITIVE_INFINITY,
      minTailDistanceM: 0,
      minTailMovingS: 0,
    });
    const flagged = new Set(hits.map((h) => h.row.id));
    const near = run(rows, home, open)
      .filter((h) => !flagged.has(h.row.id))
      .sort((a, b) => b.hit.trimS - a.hit.trimS)
      .slice(0, 10);
    out.push('');
    out.push('Longest unflagged slow tails (gates opened):');
    out.push('  date        kind  conf  tail s  tail m  moving s');
    for (const { row, hit } of near) {
      out.push(
        `  ${row.date}  ${row.kind.padEnd(4)}  ${hit.confidence.padEnd(4)}  ` +
          `${String(hit.trimS).padStart(6)}  ${String(Math.round(hit.distanceKm * 1000)).padStart(6)}  ` +
          `${String(hit.movingS).padStart(8)}`,
      );
    }
  }
  out.push('');
  // eslint-disable-next-line no-console
  console.log(out.join('\n'));
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
