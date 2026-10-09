import { query } from './db';
import {
  relativeEffortFromAverage,
  relativeEffortFromStream,
  type HrAnchors,
} from '../lib/relativeEffort';

// DB access for the ride Relative Effort backfill. Sibling to
// services/relativeEffort.ts (rides vs. runs, same precedent as the tables
// themselves). The TRIMP math is pure (lib/relativeEffort.ts); this module
// reads the HR inputs, picks the scoring tier per ride (scoreRide) and upserts
// the per-ride score. Orchestration lives in
// scripts/backfill-relative-effort-rides.ts; recomputeRideRelativeEffort
// re-scores one ride after a hand correction (MZY-253). No pace→HR surrogate
// tier here — see migrations/20260910040000_ride_relative_effort.sql for why.

/** A ride we might score: an HR stream and/or an average HR. */
export interface RideHrRow {
  rideId: string;
  date: string;
  distanceKm: number;
  durationS: number;
  avgHr: number | null;
}

/** One HR time series for a ride (a ride may have several — pick the richest). */
export interface RideHrStreamRow {
  rideId: string;
  source: string;
  timeS: number[];
  heartrate: Array<number | null>;
}

export interface RideRelativeEffortRow {
  rideId: string;
  score: number;
  method: 'stream' | 'average';
  streamSource: string | null;
  hrRest: number;
  hrMax: number;
  durationS: number | null;
  avgHr: number | null;
}

/** Rides eligible for a score: an HR stream, or an average HR. */
export async function loadScorableRides(
  rideIds?: readonly string[],
): Promise<RideHrRow[]> {
  const { rows } = await query<{
    id: string;
    date: string;
    distance_km: string;
    duration_s: number;
    avg_hr: number | null;
  }>(
    `SELECT r.id, r.date::text AS date, r.distance_km, r.duration_s, r.avg_hr
       FROM public.rides r
      WHERE (r.avg_hr IS NOT NULL
         OR EXISTS (
           SELECT 1 FROM public.ride_streams s
            WHERE s.ride_id = r.id AND s.heartrate IS NOT NULL
         ))
        AND ($1::uuid[] IS NULL OR r.id = ANY($1::uuid[]))
      ORDER BY r.date`,
    [rideIds ?? null],
  );
  return rows.map((r) => ({
    rideId: r.id,
    date: r.date,
    distanceKm: Number(r.distance_km),
    durationS: r.duration_s,
    avgHr: r.avg_hr,
  }));
}

/** Every HR stream (any source), for the rides above (or just `rideIds`). */
export async function loadRideHrStreams(
  rideIds?: readonly string[],
): Promise<RideHrStreamRow[]> {
  const { rows } = await query<{
    ride_id: string;
    source: string;
    time_s: number[];
    heartrate: Array<number | null> | null;
  }>(
    `SELECT ride_id, source, time_s, heartrate
       FROM public.ride_streams
      WHERE heartrate IS NOT NULL
        AND ($1::uuid[] IS NULL OR ride_id = ANY($1::uuid[]))`,
    [rideIds ?? null],
  );
  return rows.map((r) => ({
    rideId: r.ride_id,
    source: r.source,
    timeS: r.time_s,
    heartrate: r.heartrate ?? [],
  }));
}

/** Idempotent upsert of a ride's score (ride_id PK — recompute overwrites). */
export async function upsertRideRelativeEffort(
  row: RideRelativeEffortRow,
): Promise<void> {
  await query(
    `INSERT INTO public.ride_relative_effort
       (ride_id, score, method, stream_source, hr_rest, hr_max, duration_s, avg_hr,
        computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (ride_id) DO UPDATE SET
       score         = EXCLUDED.score,
       method        = EXCLUDED.method,
       stream_source = EXCLUDED.stream_source,
       hr_rest       = EXCLUDED.hr_rest,
       hr_max        = EXCLUDED.hr_max,
       duration_s    = EXCLUDED.duration_s,
       avg_hr        = EXCLUDED.avg_hr,
       computed_at   = now()`,
    [
      row.rideId,
      row.score,
      row.method,
      row.streamSource,
      row.hrRest,
      row.hrMax,
      row.durationS,
      row.avgHr,
    ],
  );
}

/** Remove a ride's score (it no longer has anything to be scored from). */
export async function deleteRideRelativeEffort(rideId: string): Promise<void> {
  await query('DELETE FROM public.ride_relative_effort WHERE ride_id = $1', [
    rideId,
  ]);
}

function usableSamples(s: RideHrStreamRow): number {
  return s.heartrate.reduce((n: number, v) => (v != null ? n + 1 : n), 0);
}

/** The HR stream with the most usable (non-null) samples, ≥2 to be scorable. */
export function richestRideHrStream(
  streams: RideHrStreamRow[],
): RideHrStreamRow | null {
  let best: RideHrStreamRow | null = null;
  let bestUsable = 1;
  for (const s of streams) {
    const u = usableSamples(s);
    if (u > bestUsable) {
      best = s;
      bestUsable = u;
    }
  }
  return best;
}

/**
 * Score one ride: its best HR stream integrated sample-by-sample, else its
 * average HR. Null when neither applies. Shared by the backfill script and
 * the single-ride recompute below.
 */
export function scoreRide(
  ride: RideHrRow,
  streams: RideHrStreamRow[],
  anchors: HrAnchors,
): RideRelativeEffortRow | null {
  const base = {
    rideId: ride.rideId,
    hrRest: anchors.hrRest,
    hrMax: anchors.hrMax,
    durationS: ride.durationS,
    avgHr: ride.avgHr,
  };
  const stream = richestRideHrStream(streams);
  if (stream) {
    const score = relativeEffortFromStream(
      stream.timeS,
      stream.heartrate,
      anchors,
    );
    if (score != null) {
      return { ...base, score, method: 'stream', streamSource: stream.source };
    }
  }
  if (ride.avgHr != null) {
    const score = relativeEffortFromAverage(
      ride.durationS,
      ride.avgHr,
      anchors,
    );
    if (score != null) {
      return { ...base, score, method: 'average', streamSource: null };
    }
  }
  return null;
}

/** Re-score one ride after an edit (MZY-253); drops its score if it's no longer scorable. */
export async function recomputeRideRelativeEffort(
  rideId: string,
  anchors: HrAnchors,
): Promise<RideRelativeEffortRow | null> {
  const [ride] = await loadScorableRides([rideId]);
  const row = ride
    ? scoreRide(ride, await loadRideHrStreams([rideId]), anchors)
    : null;
  if (row) await upsertRideRelativeEffort(row);
  else await deleteRideRelativeEffort(rideId);
  return row;
}
