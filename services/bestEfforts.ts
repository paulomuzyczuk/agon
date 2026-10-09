import { query } from './db';
import {
  STANDARD_EFFORT_DISTANCES,
  FULL_RUN_EFFORT_NAME,
  findBucketEffort,
  fullStreamEffort,
  wholeRunEffort,
} from '../lib/bestEfforts';
import { buildNetAdjustedStream } from '../lib/movingTime';

// DB access for the best-effort backfill. The extraction math is pure
// (lib/bestEfforts.ts); this module reads runs/run_streams, picks each run's
// rows (bestEffortsForRun) and upserts them. Orchestration lives in
// scripts/backfill-best-efforts.ts; recomputeRunBestEfforts redoes one run
// after a hand correction (MZY-253).

export interface RunForBestEffort {
  runId: string;
  date: string;
  distanceKm: number;
  durationS: number;
  /** runs.source — lets the caller refuse the whole-run fallback for unverified sources (see scripts/backfill-best-efforts.ts). */
  source: string;
}

/** Every run — every run gets a 'full_run' row, via stream or whole-run fallback. */
export async function loadRunsForBestEffort(
  runIds?: readonly string[],
): Promise<RunForBestEffort[]> {
  const { rows } = await query<{
    id: string;
    date: string;
    distance_km: string;
    duration_s: number;
    source: string;
  }>(
    `SELECT id, date::text AS date, distance_km, duration_s, source
       FROM public.runs
      WHERE $1::uuid[] IS NULL OR id = ANY($1::uuid[])
      ORDER BY date`,
    [runIds ?? null],
  );
  return rows.map((r) => ({
    runId: r.id,
    date: r.date,
    distanceKm: Number(r.distance_km),
    durationS: r.duration_s,
    source: r.source,
  }));
}

/** Removes every run_best_efforts row for the given runs — used to prune stale rows for runs newly excluded from processing. */
export async function deleteRunBestEfforts(runIds: string[]): Promise<void> {
  if (runIds.length === 0) return;
  await query('DELETE FROM public.run_best_efforts WHERE run_id = ANY($1)', [runIds]);
}

export interface DistanceStreamRow {
  runId: string;
  source: string;
  timeS: number[];
  distanceM: number[];
  /** Strava's real per-sample stop detection; null when the source doesn't carry it (paywalled API only). */
  moving: Array<boolean | null> | null;
  /** In-house speed-threshold equivalent (lib/movingTime.ts::deriveMovingFlags), computed for any distance-bearing stream. */
  derivedMoving: Array<boolean | null> | null;
  /** Steps/min (one-foot convention) — accelerometer-derived, independent of GPS speed/distance. Sparse coverage. */
  cadence: Array<number | null> | null;
  /** Steps/min (both-feet total) resampled from Fitbit-wrist 1-minute buckets (lib/fitbitCadence.ts). Sparse + gappy — see scripts/backfill-fitbit-cadence.ts's coverage gate. */
  fitbitCadence: Array<number | null> | null;
  /** The run's absolute start instant (ISO), for windowing a fresh per-run API pull (e.g. Fitbit steps). Null when the run has none. */
  startedAt: string | null;
}

/**
 * Every run_streams row that actually carries a distance series. 'fitbit'
 * streams (Google Health per-second HR) never populate distance_m, so this
 * naturally selects only the GPS-bearing sources ('strava', 'google_health').
 */
export async function loadDistanceStreams(
  runIds?: readonly string[],
): Promise<DistanceStreamRow[]> {
  const { rows } = await query<{
    run_id: string;
    source: string;
    time_s: number[];
    distance_m: Array<number | string> | null;
    moving: Array<boolean | null> | null;
    derived_moving: Array<boolean | null> | null;
    cadence: Array<number | string | null> | null;
    fitbit_cadence: Array<number | string | null> | null;
    started_at: string | null;
  }>(
    `SELECT rs.run_id, rs.source, rs.time_s, rs.distance_m, rs.moving, rs.derived_moving,
            rs.cadence, rs.fitbit_cadence,
            -- the stream's clock origin: the source's start, even after a
            -- missed-start correction moved started_at (MZY-253)
            COALESCE(r.source_started_at, r.started_at)::text AS started_at
       FROM public.run_streams rs
       JOIN public.runs r ON r.id = rs.run_id
      WHERE rs.distance_m IS NOT NULL
        AND array_length(rs.distance_m, 1) > 0
        AND ($1::uuid[] IS NULL OR rs.run_id = ANY($1::uuid[]))`,
    [runIds ?? null],
  );
  return rows.map((r) => ({
    runId: r.run_id,
    source: r.source,
    timeS: r.time_s,
    distanceM: (r.distance_m ?? []).map(Number),
    derivedMoving: r.derived_moving,
    cadence: r.cadence ? r.cadence.map((c) => (c == null ? null : Number(c))) : null,
    fitbitCadence: r.fitbit_cadence ? r.fitbit_cadence.map((c) => (c == null ? null : Number(c))) : null,
    moving: r.moving,
    startedAt: r.started_at,
  }));
}

export interface BestEffortRow {
  runId: string;
  effortName: string;
  distanceM: number;
  elapsedTimeS: number;
  method: 'stream' | 'whole_run';
  streamSource: string | null;
  achievedAt: string; // run date (no time-of-day available on `runs`)
}

/** Idempotent upsert of one (run, effort_name) row. */
export async function upsertRunBestEffort(row: BestEffortRow): Promise<void> {
  await query(
    `INSERT INTO public.run_best_efforts
       (run_id, effort_name, distance_m, elapsed_time_s, method, stream_source,
        achieved_at, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (run_id, effort_name) DO UPDATE SET
       distance_m     = EXCLUDED.distance_m,
       elapsed_time_s = EXCLUDED.elapsed_time_s,
       method         = EXCLUDED.method,
       stream_source  = EXCLUDED.stream_source,
       achieved_at    = EXCLUDED.achieved_at,
       computed_at    = now()`,
    [
      row.runId,
      row.effortName,
      row.distanceM,
      row.elapsedTimeS,
      row.method,
      row.streamSource,
      row.achievedAt,
    ],
  );
}

export interface StravaBucketPr {
  effortName: string;
  distanceM: number;
  elapsedTimeS: number;
}

/**
 * Fastest elapsed time per (Strava) effort_name from the frozen Strava-premium
 * pull — used ONLY as a one-off sanity comparison when backfilling (never
 * read by the live race-prediction pipeline, which fully cuts over to
 * run_best_efforts). Strava's own naming ('5k', 'Half-Marathon', ...) doesn't
 * match STANDARD_EFFORT_DISTANCES' naming, so the caller matches by nearest
 * distance, not by name.
 */
export async function loadStravaBucketPrsForComparison(): Promise<
  StravaBucketPr[]
> {
  const { rows } = await query<{
    effort_name: string;
    distance_m: string;
    elapsed_time_s: number;
  }>(
    `SELECT DISTINCT ON (effort_name) effort_name, distance_m, elapsed_time_s
       FROM public.strava_best_efforts
      ORDER BY effort_name, elapsed_time_s ASC, activity_started_at ASC`,
  );
  return rows.map((r) => ({
    effortName: r.effort_name,
    distanceM: Number(r.distance_m),
    elapsedTimeS: r.elapsed_time_s,
  }));
}

/** The distance-bearing stream covering the most distance, for a run. */
export function richestDistanceStream(
  streams: DistanceStreamRow[],
): DistanceStreamRow | null {
  let best: DistanceStreamRow | null = null;
  let bestCovered = 0;
  for (const s of streams) {
    if (s.timeS.length < 2 || s.distanceM.length !== s.timeS.length) continue;
    const covered = s.distanceM[s.distanceM.length - 1]! - s.distanceM[0]!;
    if (covered > bestCovered) {
      best = s;
      bestCovered = covered;
    }
  }
  return best;
}

export interface RunBestEffortResult {
  rows: BestEffortRow[];
  /**
   * stream: searched its richest distance stream · whole_run: no stream,
   * whole-run fallback · excluded: Google-Health-only, no stream (refused, see
   * scripts/backfill-best-efforts.ts) · skipped: nothing to derive from.
   */
  outcome: 'stream' | 'whole_run' | 'excluded' | 'skipped';
  /** Set when the stream search ran on a stop-corrected time axis. */
  netAdjusted: { via: 'strava' | 'derived'; stops: number; bonusS: number } | null;
}

/**
 * One run's best-effort rows. Streams carrying stop detection (Strava's
 * `moving`, else in-house `derived_moving`) are net-adjusted before the
 * sliding-window search (lib/movingTime.ts buildNetAdjustedStream).
 */
export function bestEffortsForRun(
  run: RunForBestEffort,
  streams: DistanceStreamRow[],
): RunBestEffortResult {
  const stream = richestDistanceStream(streams);
  if (stream) {
    const movingFlags = stream.moving ?? stream.derivedMoving;
    let searchTimeS = stream.timeS;
    let searchDistanceM = stream.distanceM;
    let netAdjusted: RunBestEffortResult['netAdjusted'] = null;
    if (movingFlags) {
      const adjusted = buildNetAdjustedStream(stream.timeS, stream.distanceM, movingFlags);
      if (adjusted) {
        searchTimeS = adjusted.timeS;
        searchDistanceM = adjusted.distanceM;
        if (adjusted.stopsCounted > 0) {
          netAdjusted = {
            via: stream.moving ? 'strava' : 'derived',
            stops: adjusted.stopsCounted,
            bonusS: adjusted.recoveryBonusS,
          };
        }
      }
    }
    const rows: BestEffortRow[] = [];
    for (const bucket of STANDARD_EFFORT_DISTANCES) {
      const effort = findBucketEffort(searchTimeS, searchDistanceM, bucket.meters);
      if (!effort) continue;
      rows.push({
        runId: run.runId,
        effortName: bucket.name,
        distanceM: bucket.meters,
        elapsedTimeS: effort.elapsedS,
        method: 'stream',
        streamSource: stream.source,
        achievedAt: run.date,
      });
    }
    const full = fullStreamEffort(searchTimeS, searchDistanceM);
    if (full) {
      rows.push({
        runId: run.runId,
        effortName: FULL_RUN_EFFORT_NAME,
        distanceM: full.distanceM,
        elapsedTimeS: full.timeS,
        method: 'stream',
        streamSource: stream.source,
        achievedAt: run.date,
      });
    }
    return { rows, outcome: 'stream', netAdjusted };
  }

  if (run.source === 'google_health') {
    return { rows: [], outcome: 'excluded', netAdjusted: null };
  }
  const whole = wholeRunEffort(run.distanceKm, run.durationS);
  if (!whole) return { rows: [], outcome: 'skipped', netAdjusted: null };
  return {
    rows: [
      {
        runId: run.runId,
        effortName: FULL_RUN_EFFORT_NAME,
        distanceM: whole.distanceM,
        elapsedTimeS: whole.timeS,
        method: 'whole_run',
        streamSource: null,
        achievedAt: run.date,
      },
    ],
    outcome: 'whole_run',
    netAdjusted: null,
  };
}

/**
 * Redo one run's best efforts after an edit (MZY-253). Replaces the run's rows
 * outright — a trimmed stream can lose a bucket it used to reach.
 */
export async function recomputeRunBestEfforts(runId: string): Promise<number> {
  const [run] = await loadRunsForBestEffort([runId]);
  const rows = run
    ? bestEffortsForRun(run, await loadDistanceStreams([runId])).rows
    : [];
  await deleteRunBestEfforts([runId]);
  for (const row of rows) await upsertRunBestEffort(row);
  return rows.length;
}
