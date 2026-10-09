import { readQuery } from './readonlyDb';
import { mdTable } from './curated';
import { formatPowerLabel } from '../../lib/ridePower';
import type { PowerSource } from '../../lib/types';

// Curated read-only tools for bike rides + gear mileage. Split out of
// services/mcp/curated.ts (already over the 500-line file-size budget
// before this feature — see scripts/check-file-size-budget.mjs) rather than
// growing that file further. Same read-only pool / guard idiom.

/**
 * Most recent bike rides with the headline metrics. Mirrors recentRuns.
 * Power carries its provenance in the cell ("104 W (est.)" = Strava's model,
 * not a measurement) so a consulting model never reads an estimate as data.
 * NP / IF / TSS are Agon's own (MZY-269), computed ONLY from a power meter's
 * measured stream — empty for every estimated or meter-less ride. TSS is a
 * per-ride figure; training load stays Relative Effort.
 */
export async function recentRides(limit = 20): Promise<string> {
  const rows = await readQuery<{
    date: string;
    distance_km: string | null;
    duration_s: number | null;
    avg_hr: number | null;
    avg_speed_kmh: string | null;
    avg_power_w: number | null;
    kilojoules: string | null;
    power_source: PowerSource | null;
    np_w: number | null;
    intensity_factor: string | null;
    tss: string | null;
    source: string | null;
  }>(
    `SELECT to_char(r.date,'YYYY-MM-DD') AS date, r.distance_km, r.duration_s,
            r.avg_hr, r.avg_speed_kmh, r.avg_power_w, r.kilojoules,
            r.power_source, m.np_w, m.intensity_factor, m.tss, r.source
       FROM public.rides r
       LEFT JOIN public.ride_power_metrics m ON m.ride_id = r.id
      ORDER BY r.date DESC, r.started_at DESC NULLS LAST LIMIT $1`,
    [Math.min(Math.max(limit, 1), 100)],
  );
  return mdTable(
    [
      'date',
      'km',
      'dur (min)',
      'avg HR',
      'avg km/h',
      'avg power',
      'kJ',
      'NP (measured)',
      'IF',
      'TSS',
      'source',
    ],
    rows.map((r) => [
      r.date,
      r.distance_km,
      r.duration_s === null ? null : Math.round(r.duration_s / 60),
      r.avg_hr,
      r.avg_speed_kmh,
      formatPowerLabel(r.avg_power_w, r.power_source),
      r.kilojoules,
      r.np_w === null ? null : `${r.np_w} W`,
      r.intensity_factor,
      r.tss,
      r.source,
    ]),
  );
}

/** Total mileage per gear item (shoes + bikes + ...), summed across runs and rides. */
export async function gearSummary(): Promise<string> {
  const rows = await readQuery<{
    name: string;
    category: string;
    brand: string | null;
    retired: boolean;
    total_km: string | null;
  }>(
    `SELECT g.name, g.category, g.brand, g.retired,
            round(coalesce(run_km.km, 0) + coalesce(ride_km.km, 0), 1) AS total_km
       FROM public.gear g
       LEFT JOIN (
         SELECT rg.gear_id, sum(r.distance_km) AS km
           FROM public.run_gear rg JOIN public.runs r ON r.id = rg.run_id
          GROUP BY rg.gear_id
       ) run_km ON run_km.gear_id = g.gear_id
       LEFT JOIN (
         SELECT rg.gear_id, sum(r.distance_km) AS km
           FROM public.ride_gear rg JOIN public.rides r ON r.id = rg.ride_id
          GROUP BY rg.gear_id
       ) ride_km ON ride_km.gear_id = g.gear_id
      ORDER BY g.retired, total_km DESC NULLS LAST, g.name`,
  );
  return mdTable(
    ['name', 'category', 'brand', 'total km', 'retired'],
    rows.map((r) => [
      r.name,
      r.category,
      r.brand,
      r.total_km,
      r.retired ? 'yes' : '',
    ]),
  );
}
