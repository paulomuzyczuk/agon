import { query, withTransaction } from './db';
import { computeRidePowerMetrics, type RidePowerMetrics } from '../lib/power';
import { ftpOn, type FtpEntry } from '../lib/athleteProfile';

// DB access for Agon's own ride power metrics (MZY-269): NP / IF / TSS and the
// mean-maximal curve. The math is pure (lib/power.ts); this module loads the
// DEVICE watts streams, picks one per ride, and writes ride_power_metrics +
// ride_power_curve. Orchestration: scripts/backfill-ride-power-metrics.ts
// (`pnpm power:backfill-metrics`) and the 'power_metrics' step of
// services/activityDerived.ts (after a hand correction, `pnpm ride:add`,
// `power:backfill-rides --write`, a live-recorded ride).
//
// THE PROVENANCE GATE is loadDeviceWattsStreams' WHERE clause: only a stream
// row with watts_source = 'device' is ever read. Estimated (Strava's model)
// watts must never produce an NP/TSS that looks measured. TSS never feeds
// training load (.claude/rules/premium-parity.md #8).

/** One ride's device-measured watts series. */
export interface DeviceWattsStream {
  rideId: string;
  /** rides.date — picks the FTP in force (ftpOn). */
  date: string;
  source: string;
  timeS: number[];
  watts: Array<number | null>;
}

export interface RidePowerMetricsRow extends RidePowerMetrics {
  rideId: string;
  streamSource: string;
}

/** Every DEVICE watts stream (any source), for all rides or just `rideIds`. */
export async function loadDeviceWattsStreams(
  rideIds?: readonly string[],
): Promise<DeviceWattsStream[]> {
  const { rows } = await query<{
    ride_id: string;
    date: string;
    source: string;
    time_s: number[];
    watts: Array<number | null>;
  }>(
    `SELECT s.ride_id, r.date::text AS date, s.source, s.time_s, s.watts
       FROM public.ride_streams s
       JOIN public.rides r ON r.id = s.ride_id
      WHERE s.watts IS NOT NULL
        AND s.watts_source = 'device'
        AND ($1::uuid[] IS NULL OR s.ride_id = ANY($1::uuid[]))
      ORDER BY r.date, s.ride_id, s.source`,
    [rideIds ?? null],
  );
  return rows.map((r) => ({
    rideId: r.ride_id,
    date: r.date,
    source: r.source,
    timeS: r.time_s,
    watts: r.watts,
  }));
}

function usableWatts(s: DeviceWattsStream): number {
  return s.watts.reduce((n: number, w) => (w != null ? n + 1 : n), 0);
}

/**
 * The device stream with the most non-null watts (a ride can hold, say, a
 * live-recorded and an imported meter series). Ties keep the first, which is
 * deterministic given loadDeviceWattsStreams' ORDER BY. Null when none has any.
 */
export function pickDeviceStream(
  streams: readonly DeviceWattsStream[],
): DeviceWattsStream | null {
  let best: DeviceWattsStream | null = null;
  let bestUsable = 0;
  for (const s of streams) {
    const u = usableWatts(s);
    if (u > bestUsable) {
      best = s;
      bestUsable = u;
    }
  }
  return best;
}

/** Metrics for one ride's streams, or null when there is nothing to compute. */
export function scoreRidePower(
  streams: readonly DeviceWattsStream[],
  ftpHistory: readonly FtpEntry[] | undefined,
): RidePowerMetricsRow | null {
  const stream = pickDeviceStream(streams);
  if (!stream) return null;
  const metrics = computeRidePowerMetrics(
    stream.timeS,
    stream.watts,
    ftpOn(stream.date, ftpHistory),
  );
  return metrics
    ? { ...metrics, rideId: stream.rideId, streamSource: stream.source }
    : null;
}

/** Idempotent write of a ride's metrics + its whole curve, in one transaction. */
export async function upsertRidePowerMetrics(
  row: RidePowerMetricsRow,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO public.ride_power_metrics
         (ride_id, stream_source, ftp_w, np_w, intensity_factor, tss,
          duration_s, avg_power_w, max_power_w, kilojoules, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (ride_id) DO UPDATE SET
         stream_source    = EXCLUDED.stream_source,
         ftp_w            = EXCLUDED.ftp_w,
         np_w             = EXCLUDED.np_w,
         intensity_factor = EXCLUDED.intensity_factor,
         tss              = EXCLUDED.tss,
         duration_s       = EXCLUDED.duration_s,
         avg_power_w      = EXCLUDED.avg_power_w,
         max_power_w      = EXCLUDED.max_power_w,
         kilojoules       = EXCLUDED.kilojoules,
         computed_at      = now()`,
      [
        row.rideId,
        row.streamSource,
        row.ftpW,
        row.npW,
        row.intensityFactor,
        row.tss,
        row.durationS,
        row.avgPowerW,
        row.maxPowerW,
        row.kilojoules,
      ],
    );
    // Replace the curve wholesale: a shorter (trimmed) stream drops durations.
    await client.query(
      'DELETE FROM public.ride_power_curve WHERE ride_id = $1',
      [row.rideId],
    );
    if (row.curve.length > 0) {
      await client.query(
        `INSERT INTO public.ride_power_curve (ride_id, duration_s, watts)
         SELECT $1, d, w FROM unnest($2::int[], $3::int[]) AS t(d, w)`,
        [
          row.rideId,
          row.curve.map((p) => p.durationS),
          row.curve.map((p) => p.watts),
        ],
      );
    }
  });
}

/** Remove a ride's metrics and curve (it no longer has a usable device stream). */
export async function deleteRidePowerMetrics(rideId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      'DELETE FROM public.ride_power_curve WHERE ride_id = $1',
      [rideId],
    );
    await client.query(
      'DELETE FROM public.ride_power_metrics WHERE ride_id = $1',
      [rideId],
    );
  });
}

/**
 * Recompute one ride's power metrics from its device stream(s). Deletes any
 * stale row when the ride no longer has one (stream removed, or too short) —
 * so a trimmed or replaced stream never leaves numbers behind.
 */
export async function recomputeRidePowerMetrics(
  rideId: string,
  ftpHistory: readonly FtpEntry[] | undefined,
): Promise<RidePowerMetricsRow | null> {
  const row = scoreRidePower(
    await loadDeviceWattsStreams([rideId]),
    ftpHistory,
  );
  if (row) await upsertRidePowerMetrics(row);
  else await deleteRidePowerMetrics(rideId);
  return row;
}
