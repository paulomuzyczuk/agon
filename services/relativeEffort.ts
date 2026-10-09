import { query } from './db';
import {
  fitPaceHrModel,
  relativeEffortFromAverage,
  relativeEffortFromPace,
  relativeEffortFromStream,
  type HrAnchors,
  type PaceHrModel,
} from '../lib/relativeEffort';

// DB access for the Relative Effort backfill. The TRIMP math is pure
// (lib/relativeEffort.ts); this module reads the HR inputs, picks the scoring
// tier per run (scoreRun) and upserts the per-run score. Orchestration lives
// in scripts/backfill-relative-effort.ts; recomputeRunRelativeEffort re-scores
// one run after a hand correction (MZY-253).

/**
 * A run we might score. Ordered by fidelity, it may carry an HR stream and/or an
 * average HR; when it has NEITHER, avgPaceSPerKm lets the pace→HR surrogate score
 * it as a last resort (lib/relativeEffort.relativeEffortFromPace).
 */
export interface RunHrRow {
  runId: string;
  date: string;
  distanceKm: number;
  durationS: number;
  avgHr: number | null;
  avgPaceSPerKm: number | null;
}

// Data-quality gate for the pace→HR fit: only learn from runs with a plausible
// running average HR and a genuine running pace. Sub-120-bpm "averages" are
// sensor-dropout artifacts and 10 min/km+ efforts are walks — both would distort
// the fit (they flatten the pace→HR slope toward noise).
const PACE_HR_FIT_MIN_HR = 120;
const PACE_HR_FIT_MAX_PACE_S_PER_KM = 600;

/** One HR time series for a run (a run may have several — pick the richest). */
export interface HrStreamRow {
  runId: string;
  source: string;
  timeS: number[];
  heartrate: Array<number | null>;
}

export interface RelativeEffortRow {
  runId: string;
  score: number;
  method: 'stream' | 'average' | 'estimated_pace';
  streamSource: string | null;
  hrRest: number;
  hrMax: number;
  durationS: number | null;
  avgHr: number | null;
}

/**
 * Runs eligible for a score, richest-signal first: an HR stream, an average HR,
 * or (last resort) just a pace + duration for the pace→HR surrogate. A run with
 * none of these (no duration/pace) is excluded — nothing to score it from.
 */
export async function loadScorableRuns(
  runIds?: readonly string[],
): Promise<RunHrRow[]> {
  const { rows } = await query<{
    id: string;
    date: string;
    distance_km: string;
    duration_s: number;
    avg_hr: number | null;
    avg_pace_s_per_km: string | null;
  }>(
    `SELECT r.id, r.date::text AS date, r.distance_km, r.duration_s, r.avg_hr,
            r.avg_pace_s_per_km
       FROM public.runs r
      WHERE (r.avg_hr IS NOT NULL
         OR EXISTS (
           SELECT 1 FROM public.run_streams s
            WHERE s.run_id = r.id AND s.heartrate IS NOT NULL
         )
         OR (r.avg_pace_s_per_km IS NOT NULL AND r.duration_s > 0))
        AND ($1::uuid[] IS NULL OR r.id = ANY($1::uuid[]))
      ORDER BY r.date`,
    [runIds ?? null],
  );
  return rows.map((r) => ({
    runId: r.id,
    date: r.date,
    distanceKm: Number(r.distance_km),
    durationS: r.duration_s,
    avgHr: r.avg_hr,
    avgPaceSPerKm:
      r.avg_pace_s_per_km == null ? null : Number(r.avg_pace_s_per_km),
  }));
}

/**
 * Measured (speed, HR) pairs to fit the athlete's pace→HR model — only runs with
 * a real HR stream (so the average is genuine, not a manual estimate), a plausible
 * running HR, and a running (not walking) pace. Feeds lib/relativeEffort.fitPaceHrModel.
 */
export async function loadPaceHrPairs(): Promise<
  Array<{ speedMps: number; hr: number }>
> {
  const { rows } = await query<{ speed_mps: string; hr: number }>(
    `SELECT 1000.0 / r.avg_pace_s_per_km AS speed_mps, r.avg_hr AS hr
       FROM public.runs r
      WHERE r.avg_hr IS NOT NULL
        AND r.avg_hr_estimated = false
        AND r.avg_pace_s_per_km IS NOT NULL
        AND r.avg_hr >= $1
        AND r.avg_pace_s_per_km <= $2
        AND EXISTS (
          SELECT 1 FROM public.run_streams s
           WHERE s.run_id = r.id
             AND s.heartrate IS NOT NULL
             AND array_length(s.heartrate, 1) > 0
        )`,
    [PACE_HR_FIT_MIN_HR, PACE_HR_FIT_MAX_PACE_S_PER_KM],
  );
  return rows.map((r) => ({ speedMps: Number(r.speed_mps), hr: Number(r.hr) }));
}

/** Every HR stream (any source), for the runs above (or just `runIds`). */
export async function loadHrStreams(
  runIds?: readonly string[],
): Promise<HrStreamRow[]> {
  const { rows } = await query<{
    run_id: string;
    source: string;
    time_s: number[];
    heartrate: Array<number | null> | null;
  }>(
    `SELECT run_id, source, time_s, heartrate
       FROM public.run_streams
      WHERE heartrate IS NOT NULL
        AND ($1::uuid[] IS NULL OR run_id = ANY($1::uuid[]))`,
    [runIds ?? null],
  );
  return rows.map((r) => ({
    runId: r.run_id,
    source: r.source,
    timeS: r.time_s,
    heartrate: r.heartrate ?? [],
  }));
}

/** Idempotent upsert of a run's score (run_id PK — recompute overwrites). */
export async function upsertRunRelativeEffort(
  row: RelativeEffortRow,
): Promise<void> {
  await query(
    `INSERT INTO public.run_relative_effort
       (run_id, score, method, stream_source, hr_rest, hr_max, duration_s, avg_hr,
        computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (run_id) DO UPDATE SET
       score         = EXCLUDED.score,
       method        = EXCLUDED.method,
       stream_source = EXCLUDED.stream_source,
       hr_rest       = EXCLUDED.hr_rest,
       hr_max        = EXCLUDED.hr_max,
       duration_s    = EXCLUDED.duration_s,
       avg_hr        = EXCLUDED.avg_hr,
       computed_at   = now()`,
    [
      row.runId,
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

/** Remove a run's score (it no longer has anything to be scored from). */
export async function deleteRunRelativeEffort(runId: string): Promise<void> {
  await query('DELETE FROM public.run_relative_effort WHERE run_id = $1', [
    runId,
  ]);
}

function usableSamples(s: HrStreamRow): number {
  return s.heartrate.reduce((n: number, v) => (v != null ? n + 1 : n), 0);
}

/** The HR stream with the most usable (non-null) samples, ≥2 to be scorable. */
export function richestHrStream(streams: HrStreamRow[]): HrStreamRow | null {
  let best: HrStreamRow | null = null;
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
 * Score one run, richest signal first: its best HR stream integrated
 * sample-by-sample, else its average HR, else (no HR at all) the pace→HR
 * surrogate. Null when none applies. Shared by scripts/backfill-relative-
 * effort.ts and the single-run recompute below.
 */
export function scoreRun(
  run: RunHrRow,
  streams: HrStreamRow[],
  anchors: HrAnchors,
  paceModel: PaceHrModel | null,
): RelativeEffortRow | null {
  const base = {
    runId: run.runId,
    hrRest: anchors.hrRest,
    hrMax: anchors.hrMax,
    durationS: run.durationS,
  };
  const stream = richestHrStream(streams);
  if (stream) {
    const score = relativeEffortFromStream(
      stream.timeS,
      stream.heartrate,
      anchors,
    );
    if (score != null) {
      return {
        ...base,
        score,
        method: 'stream',
        streamSource: stream.source,
        avgHr: run.avgHr,
      };
    }
  }
  if (run.avgHr != null) {
    const score = relativeEffortFromAverage(run.durationS, run.avgHr, anchors);
    if (score != null) {
      return {
        ...base,
        score,
        method: 'average',
        streamSource: null,
        avgHr: run.avgHr,
      };
    }
  }
  // avgHr on the row is the pace-ESTIMATED HR (provenance); runs.avg_hr stays NULL.
  if (run.avgHr == null && paceModel && run.avgPaceSPerKm != null) {
    const pe = relativeEffortFromPace(
      run.durationS,
      run.distanceKm,
      paceModel,
      anchors,
    );
    if (pe != null) {
      return {
        ...base,
        score: pe.score,
        method: 'estimated_pace',
        streamSource: null,
        avgHr: pe.estimatedHr,
      };
    }
  }
  return null;
}

/** Re-score one run after an edit (MZY-253); drops its score if it's no longer scorable. */
export async function recomputeRunRelativeEffort(
  runId: string,
  anchors: HrAnchors,
): Promise<RelativeEffortRow | null> {
  const [run] = await loadScorableRuns([runId]);
  const row = run
    ? scoreRun(
        run,
        await loadHrStreams([runId]),
        anchors,
        fitPaceHrModel(await loadPaceHrPairs()),
      )
    : null;
  if (row) await upsertRunRelativeEffort(row);
  else await deleteRunRelativeEffort(runId);
  return row;
}
