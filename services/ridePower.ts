import { query } from './db';
import {
  upsertRideStreams,
  type RideStreamData,
  type StreamSource,
} from './runStreams';
import type { RidePowerFields } from '../lib/types';
import { RIDE_POWER_FIELDS } from '../lib/ridePower';

// DB writes for the ride power backfill (MZY-267). Targeted on purpose: the
// backfill only adds power to rides that already exist, so it touches the
// power columns and the watts series and nothing else. A full upsertRide or
// upsertRideStreams would also re-take every other source-owned column and
// re-write a stream the athlete may have hand-trimmed (a trim is never undone
// by a re-fetch — services/activityCorrections.ts revertCorrections).

export interface StoredRidePower extends RidePowerFields {
  id: string;
  externalId: string;
  date: string;
  startedAt: string | null;
  correctedFields: string[];
}

/** Every stored Strava ride with its current power columns. */
export async function listStravaRidesForPower(): Promise<StoredRidePower[]> {
  const { rows } = await query<{
    id: string;
    external_id: string;
    date: string;
    started_at: Date | null;
    avg_power_w: number | null;
    max_power_w: number | null;
    weighted_avg_power_w: number | null;
    kilojoules: number | null;
    power_source: RidePowerFields['power_source'];
    corrected_fields: string[];
  }>(
    `SELECT id, external_id, date::text AS date, started_at,
            avg_power_w, max_power_w, weighted_avg_power_w,
            kilojoules::float8 AS kilojoules, power_source, corrected_fields
       FROM public.rides
      WHERE source = 'strava' AND external_id IS NOT NULL
      ORDER BY started_at NULLS LAST`,
  );
  return rows.map((r) => ({
    id: r.id,
    externalId: r.external_id,
    date: r.date,
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    avg_power_w: r.avg_power_w,
    max_power_w: r.max_power_w,
    weighted_avg_power_w: r.weighted_avg_power_w,
    kilojoules: r.kilojoules,
    power_source: r.power_source,
    correctedFields: r.corrected_fields,
  }));
}

/**
 * Write a ride's power columns unless the athlete corrected any of them (the
 * group is then frozen — same rule as upsertSetKeepingCorrections). Returns
 * whether the row was written.
 */
export async function updateRidePower(
  rideId: string,
  p: RidePowerFields,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE public.rides
        SET avg_power_w = $2, max_power_w = $3, weighted_avg_power_w = $4,
            kilojoules = $5, power_source = $6
      WHERE id = $1
        AND NOT (corrected_fields && $7::text[])`,
    [
      rideId,
      p.avg_power_w,
      p.max_power_w,
      p.weighted_avg_power_w,
      p.kilojoules,
      p.power_source,
      RIDE_POWER_FIELDS,
    ],
  );
  return (rowCount ?? 0) > 0;
}

export type StreamWattsResult = 'updated' | 'inserted' | 'length_mismatch';

/**
 * Attach a freshly fetched watts series to a ride's stream row WITHOUT
 * replacing the row's other series. Only when the stored row has the same
 * sample count as the fetch (otherwise it was trimmed by hand, and its
 * indices no longer line up → 'length_mismatch', nothing written). With no
 * stored row yet, the whole fetched stream is inserted.
 */
export async function updateRideStreamWatts(
  rideId: string,
  source: StreamSource,
  data: RideStreamData,
): Promise<StreamWattsResult> {
  if (!data.watts || !data.wattsSource) {
    throw new Error(
      `updateRideStreamWatts: ride ${rideId} has no labelled watts to store`,
    );
  }
  const { rowCount } = await query(
    `UPDATE public.ride_streams
        SET watts = $3, watts_source = $4, fetched_at = now()
      WHERE ride_id = $1 AND source = $2 AND sample_count = $5`,
    [rideId, source, data.watts, data.wattsSource, data.timeS.length],
  );
  if ((rowCount ?? 0) > 0) return 'updated';

  const { rows } = await query(
    'SELECT 1 FROM public.ride_streams WHERE ride_id = $1 AND source = $2',
    [rideId, source],
  );
  if (rows.length > 0) return 'length_mismatch';
  await upsertRideStreams(rideId, source, data);
  return 'inserted';
}
