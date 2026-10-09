import type { PoolClient } from 'pg';
import { query, withTransaction } from './db';
import { logger } from './logger';
import {
  partitionOverlaps,
  type OverlapPartition,
  type StoredActivity,
} from '../lib/activitySourcePriority';

// DB side of the activity source priority (MZY-225; policy in
// lib/activitySourcePriority.ts). Finds stored runs/rides that overlap an
// incoming one, and merges a superseded lower-priority row into the winner.
//
// A merge keeps everything the loser knew that the winner doesn't: its streams
// (a Fitbit wrist-HR series survives next to Strava's GPS one), gear links,
// fueling intake, sweat weigh-ins, Strava moving/elapsed times, qualitative
// notes (appended, like updateRunQualitative), and weather/GPS-start (filled
// only where the winner has none). The loser row is then deleted; its DERIVED
// rows (best efforts, Relative Effort, fueling balance) cascade away and are
// rebuilt for the winner by the usual backfills (be:/re:/fueling:backfill).

export type ActivityKind = 'run' | 'ride';

/** Treat activities within a minute of overlap as the same one (ingest-wide convention). */
const OVERLAP_SLACK_MS = 60_000;

export interface IncomingActivity {
  source: string;
  external_id: string | null;
  started_at: string | null;
  duration_s: number;
}

const TABLE: Record<ActivityKind, 'runs' | 'rides'> = {
  run: 'runs',
  ride: 'rides',
};

/**
 * Stored activities of any source overlapping this interval, excluding the
 * incoming record's own (source, external_id) so an idempotent re-sync of the
 * same activity updates in place rather than tripping over itself.
 */
export async function findOverlappingActivities(
  kind: ActivityKind,
  startMs: number,
  endMs: number,
  self: { source: string; externalId: string | null },
): Promise<StoredActivity[]> {
  // The window uses started_at (a missed-start correction only moves it
  // earlier, so the window only widens), but the start REPORTED for the
  // 5-min supersede match is the source's own (MZY-253): a twin from another
  // app starts at the source time, not at the hand-corrected one.
  const { rows } = await query<{
    id: string;
    source: string;
    started_at: Date;
  }>(
    `SELECT id, source, COALESCE(source_started_at, started_at) AS started_at
       FROM public.${TABLE[kind]}
      WHERE NOT (source = $3 AND external_id IS NOT DISTINCT FROM $4)
        AND started_at IS NOT NULL
        AND started_at < $2::timestamptz
        AND (started_at + make_interval(secs => duration_s)) > $1::timestamptz
      ORDER BY started_at`,
    [
      new Date(startMs - OVERLAP_SLACK_MS).toISOString(),
      new Date(endMs + OVERLAP_SLACK_MS).toISOString(),
      self.source,
      self.externalId,
    ],
  );
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    startedAtMs: new Date(r.started_at).getTime(),
  }));
}

/**
 * What an incoming activity should do about the stored ones it overlaps. An
 * activity with no start time can't be time-matched → nothing overlaps.
 */
export async function classifyIncomingActivity(
  kind: ActivityKind,
  a: IncomingActivity,
): Promise<OverlapPartition> {
  const empty: OverlapPartition = {
    blocking: [],
    supersede: [],
    ambiguous: [],
  };
  if (a.started_at == null) return empty;
  const startMs = Date.parse(a.started_at);
  if (!Number.isFinite(startMs)) return empty;

  const stored = await findOverlappingActivities(
    kind,
    startMs,
    startMs + a.duration_s * 1000,
    { source: a.source, externalId: a.external_id },
  );
  const p = partitionOverlaps(
    { source: a.source, startedAtMs: startMs },
    stored,
  );
  if (p.ambiguous.length > 0) {
    logger.warn(
      `${kind} overlaps a lower-priority ${kind} but starts >5 min apart — left both`,
      {
        job: 'activity-source-priority',
        incomingSource: a.source,
        incomingExternalId: a.external_id,
        ambiguous: p.ambiguous.map((s) => `${s.source}:${s.id}`),
      },
    );
  }
  return p;
}

/** Merge each superseded row into the winner (one transaction per loser). */
export async function supersedeActivities(
  kind: ActivityKind,
  winnerId: string,
  losers: StoredActivity[],
): Promise<number> {
  for (const l of losers) {
    await withTransaction((c) =>
      kind === 'run'
        ? mergeRunInto(c, l.id, winnerId)
        : mergeRideInto(c, l.id, winnerId),
    );
    logger.info(`${kind} superseded by a higher-priority source`, {
      job: 'activity-source-priority',
      winnerId,
      loserId: l.id,
      loserSource: l.source,
    });
  }
  return losers.length;
}

/**
 * Before a superseding Strava run is upserted: free the loser's
 * strava_activity_id (UNIQUE on runs) if it carries the same one, or the insert
 * would collide with the very row it's about to replace.
 */
export async function releaseStravaActivityId(
  losers: StoredActivity[],
  stravaActivityId: number | null,
): Promise<void> {
  if (stravaActivityId == null || losers.length === 0) return;
  await query(
    `UPDATE public.runs SET strava_activity_id = NULL
      WHERE id = ANY($1::uuid[]) AND strava_activity_id = $2`,
    [losers.map((l) => l.id), stravaActivityId],
  );
}

// Free-text columns append with ' | ' (skipping an exact repeat); everything
// else keeps the winner's value and only fills a gap from the loser.
const appendText = (col: string) => `${col} = CASE
       WHEN l.${col} IS NULL OR l.${col} = '' THEN w.${col}
       WHEN w.${col} IS NULL OR w.${col} = '' THEN l.${col}
       WHEN w.${col} = l.${col} THEN w.${col}
       ELSE w.${col} || ' | ' || l.${col}
     END`;
const fill = (col: string) => `${col} = COALESCE(w.${col}, l.${col})`;

const SHARED_FILL = [
  'avg_hr',
  'max_hr',
  'perceived_effort',
  'temp_c',
  'humidity_pct',
  'wind_kph',
  'weather_conditions',
];

// A live recording's gain is Agon's own estimate from noisy phone altitude
// (lib/elevationGain.ts, MZY-295); an upstream gain (Strava's DEM/barometer,
// Google Health) is better, so it wins over ours, and fills a gap otherwise.
const ELEVATION_GAIN = `elevation_gain_m = CASE
       WHEN w.source = 'live_recording'
         THEN COALESCE(l.elevation_gain_m, w.elevation_gain_m)
       ELSE COALESCE(w.elevation_gain_m, l.elevation_gain_m)
     END`;

// The GPS start is a pair — take the loser's only when the winner has neither.
const START_PAIR = `
       start_lat = CASE WHEN w.start_lat IS NULL THEN l.start_lat ELSE w.start_lat END,
       start_lng = CASE WHEN w.start_lat IS NULL THEN l.start_lng ELSE w.start_lng END`;

export async function mergeRunInto(
  c: PoolClient,
  loserId: string,
  winnerId: string,
): Promise<void> {
  await c.query(
    `UPDATE public.runs w SET
       ${['fueling', 'general_notes', 'pain_location'].map(appendText).join(',\n       ')},
       ${[...SHARED_FILL, 'pain_onset_km', 'shoe_used'].map(fill).join(',\n       ')},
       ${ELEVATION_GAIN},
       avg_hr_estimated = CASE WHEN w.avg_hr IS NULL THEN l.avg_hr_estimated
                               ELSE w.avg_hr_estimated END,${START_PAIR}
       FROM public.runs l
      WHERE w.id = $1 AND l.id = $2`,
    [winnerId, loserId],
  );
  // One stream per (run, source): keep the winner's own where both have one.
  await c.query(
    `UPDATE public.run_streams SET run_id = $1
      WHERE run_id = $2
        AND source NOT IN (SELECT source FROM public.run_streams WHERE run_id = $1)`,
    [winnerId, loserId],
  );
  await c.query(
    `INSERT INTO public.run_gear (run_id, gear_id)
     SELECT $1, gear_id FROM public.run_gear WHERE run_id = $2
     ON CONFLICT DO NOTHING`,
    [winnerId, loserId],
  );
  for (const t of [
    'run_fueling_items',
    'sweat_observations',
    'strava_activity_times',
  ]) {
    await c.query(`UPDATE public.${t} SET run_id = $1 WHERE run_id = $2`, [
      winnerId,
      loserId,
    ]);
  }
  await c.query(`DELETE FROM public.runs WHERE id = $1`, [loserId]);
}

export async function mergeRideInto(
  c: PoolClient,
  loserId: string,
  winnerId: string,
): Promise<void> {
  await c.query(
    `UPDATE public.rides w SET
       ${appendText('general_notes')},
       ${[...SHARED_FILL, 'bike_used', 'avg_speed_kmh', 'max_speed_kmh'].map(fill).join(',\n       ')},
       ${ELEVATION_GAIN},${START_PAIR}
       FROM public.rides l
      WHERE w.id = $1 AND l.id = $2`,
    [winnerId, loserId],
  );
  await c.query(
    `UPDATE public.ride_streams SET ride_id = $1
      WHERE ride_id = $2
        AND source NOT IN (SELECT source FROM public.ride_streams WHERE ride_id = $1)`,
    [winnerId, loserId],
  );
  await c.query(
    `INSERT INTO public.ride_gear (ride_id, gear_id)
     SELECT $1, gear_id FROM public.ride_gear WHERE ride_id = $2
     ON CONFLICT DO NOTHING`,
    [winnerId, loserId],
  );
  for (const t of ['ride_fueling_items', 'strava_activity_times']) {
    await c.query(`UPDATE public.${t} SET ride_id = $1 WHERE ride_id = $2`, [
      winnerId,
      loserId,
    ]);
  }
  await c.query(`DELETE FROM public.rides WHERE id = $1`, [loserId]);
}
