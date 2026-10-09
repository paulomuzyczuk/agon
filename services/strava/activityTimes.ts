import { query } from '../db';
import { computeMovingTime } from '../../lib/movingTime';
import { matchActivity, type ExistingRunLite } from './matchEnrich';
import type { StravaSummaryActivity } from './types';

// Strava moving/elapsed time reference pull (MZY-40). Strava's `moving_time`
// (its own auto-pause) and `elapsed_time` are paywall-only — no free export
// carries them (docs/methodology-log.md 2026-09-05). While a premium window has
// the API open, `pnpm strava:times` stores both for every run/ride activity in
// public.strava_activity_times and reconciles Agon's in-house estimates
// (lib/movingTime.ts) against them. The summary list endpoint already carries
// both fields, so the whole history costs ~1 API call per 200 activities.
//
// Pure mapping + reconciliation live here (unit-tested); I/O orchestration is
// scripts/pull-strava-activity-times.ts.

export type ActivityKind = 'run' | 'ride';

export interface StravaActivityTimes {
  stravaActivityId: number;
  activityKind: ActivityKind;
  sportType: string | null;
  startedAt: string;
  distanceM: number;
  movingTimeS: number;
  elapsedTimeS: number;
  runId: string | null;
  rideId: string | null;
}

/** Pure: a summary activity → a reference row (links resolved by the caller). */
export function toActivityTimes(
  a: StravaSummaryActivity,
  kind: ActivityKind,
  link: { runId?: string | null; rideId?: string | null } = {},
): StravaActivityTimes {
  return {
    stravaActivityId: a.id,
    activityKind: kind,
    sportType: a.sport_type ?? a.type ?? null,
    startedAt: new Date(a.start_date).toISOString(),
    distanceM: Math.round(a.distance * 10) / 10,
    movingTimeS: a.moving_time,
    elapsedTimeS: a.elapsed_time,
    runId: kind === 'run' ? (link.runId ?? null) : null,
    rideId: kind === 'ride' ? (link.rideId ?? null) : null,
  };
}

/** A run or ride row an activity can link to. */
export interface LinkTarget extends ExistingRunLite {
  source: string;
  externalId: string | null;
}

/** Same bound as scripts/enrich-runs-from-strava.ts: beyond this, likely a split run. */
export const MAX_LINK_DIST_DELTA_PCT = 25;

export interface ActivityLink {
  id: string;
  via: 'external_id' | 'time_match';
}

/**
 * Pure: the Agon row this activity describes, or null. A source='strava' row
 * with the activity id as external_id is the same activity by identity; anything
 * else (google_health, file imports) needs a confident time-overlap match
 * (matchEnrich.ts) with distances within MAX_LINK_DIST_DELTA_PCT. `claimed`
 * holds ids already linked this pass — one row, one activity; the first (newest,
 * Strava pages newest-first) wins, and the caller adds the returned id.
 */
export function linkActivity(
  a: StravaSummaryActivity,
  targets: readonly LinkTarget[],
  claimed: ReadonlySet<string>,
): ActivityLink | null {
  const direct = targets.find(
    (t) => t.source === 'strava' && t.externalId === String(a.id),
  );
  if (direct)
    return claimed.has(direct.id)
      ? null
      : { id: direct.id, via: 'external_id' };

  const m = matchActivity(
    {
      id: a.id,
      startMs: Date.parse(a.start_date),
      durationS: a.elapsed_time,
      distanceKm: a.distance / 1000,
    },
    targets,
  );
  if (!m || claimed.has(m.run.id)) return null;
  if (
    m.distDeltaPct != null &&
    Math.abs(m.distDeltaPct) > MAX_LINK_DIST_DELTA_PCT
  )
    return null;
  return { id: m.run.id, via: 'time_match' };
}

/** Idempotent upsert keyed on strava_activity_id. Returns rows written. */
export async function upsertActivityTimes(
  rows: StravaActivityTimes[],
): Promise<number> {
  for (const r of rows) {
    await query(
      `INSERT INTO public.strava_activity_times
         (strava_activity_id, activity_kind, sport_type, started_at, distance_m,
          moving_time_s, elapsed_time_s, run_id, ride_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (strava_activity_id) DO UPDATE SET
         activity_kind  = EXCLUDED.activity_kind,
         sport_type     = EXCLUDED.sport_type,
         started_at     = EXCLUDED.started_at,
         distance_m     = EXCLUDED.distance_m,
         moving_time_s  = EXCLUDED.moving_time_s,
         elapsed_time_s = EXCLUDED.elapsed_time_s,
         run_id         = EXCLUDED.run_id,
         ride_id        = EXCLUDED.ride_id,
         captured_at    = now()`,
      [
        r.stravaActivityId,
        r.activityKind,
        r.sportType,
        r.startedAt,
        r.distanceM,
        r.movingTimeS,
        r.elapsedTimeS,
        r.runId,
        r.rideId,
      ],
    );
  }
  return rows.length;
}

// ── Reconciliation ──────────────────────────────────────────────────────────

/** Everything Agon knows locally about one Strava-linked activity. */
export interface LocalTimes {
  label: string;
  /** Strava's reference values. */
  stravaMovingS: number;
  stravaElapsedS: number;
  /** The Agon row's own duration_s (source-reported). */
  durationS: number | null;
  /** Stream time axis + flags, when a stream exists. */
  timeS: number[] | null;
  moving: Array<boolean | null> | null;
  derivedMoving: Array<boolean | null> | null;
}

/**
 * One local estimator, compared against one Strava reference field. The
 * estimate function returns null when the input can't support it (no stream,
 * no flag), and that activity is simply excluded from that estimator's stats.
 */
interface Estimator {
  name: string;
  reference: 'moving' | 'elapsed';
  estimate: (t: LocalTimes) => number | null;
}

function streamSpanS(timeS: number[] | null): number | null {
  if (!timeS || timeS.length < 2) return null;
  return timeS[timeS.length - 1]! - timeS[0]!;
}

export const ESTIMATORS: readonly Estimator[] = [
  {
    // Our recompute over Strava's own per-sample flag — isolates the effect of
    // computeMovingTime's confirmed-stop gating from the flag itself.
    name: 'computeMovingTime(moving)',
    reference: 'moving',
    estimate: (t) =>
      t.timeS && t.moving
        ? (computeMovingTime(t.timeS, t.moving)?.movingTimeS ?? null)
        : null,
  },
  {
    // The in-house speed-threshold flag — what every non-Strava run relies on.
    name: 'computeMovingTime(derived_moving)',
    reference: 'moving',
    estimate: (t) =>
      t.timeS && t.derivedMoving
        ? (computeMovingTime(t.timeS, t.derivedMoving)?.movingTimeS ?? null)
        : null,
  },
  { name: 'duration_s', reference: 'moving', estimate: (t) => t.durationS },
  { name: 'duration_s', reference: 'elapsed', estimate: (t) => t.durationS },
  {
    name: 'stream span',
    reference: 'elapsed',
    estimate: (t) => streamSpanS(t.timeS),
  },
];

export interface EstimatorStats {
  estimator: string;
  reference: 'moving' | 'elapsed';
  n: number;
  /** Mean (local − Strava), seconds. Positive = local over-counts. */
  meanBiasS: number;
  /** Mean |local − Strava|, seconds. */
  maeS: number;
  /** Mean |local − Strava| / Strava, percent. */
  mapePct: number;
  /** Share of activities within ±30 s of Strava, percent. */
  within30sPct: number;
  /** Largest |error| cases, for eyeballing. */
  worst: Array<{
    label: string;
    localS: number;
    stravaS: number;
    deltaS: number;
  }>;
}

const WORST_N = 5;

/** Pure: per-estimator error stats against Strava's reference times. */
export function reconcile(items: LocalTimes[]): EstimatorStats[] {
  return ESTIMATORS.map((est) => {
    const errs: Array<{
      label: string;
      localS: number;
      stravaS: number;
      deltaS: number;
    }> = [];
    for (const t of items) {
      const local = est.estimate(t);
      const ref =
        est.reference === 'moving' ? t.stravaMovingS : t.stravaElapsedS;
      if (local == null || ref <= 0) continue;
      errs.push({
        label: t.label,
        localS: local,
        stravaS: ref,
        deltaS: local - ref,
      });
    }
    const n = errs.length;
    const sum = (f: (e: (typeof errs)[number]) => number): number =>
      errs.reduce((s, e) => s + f(e), 0);
    return {
      estimator: est.name,
      reference: est.reference,
      n,
      meanBiasS: n ? sum((e) => e.deltaS) / n : 0,
      maeS: n ? sum((e) => Math.abs(e.deltaS)) / n : 0,
      mapePct: n ? (sum((e) => Math.abs(e.deltaS) / e.stravaS) / n) * 100 : 0,
      within30sPct: n
        ? (errs.filter((e) => Math.abs(e.deltaS) <= 30).length / n) * 100
        : 0,
      worst: [...errs]
        .sort((a, b) => Math.abs(b.deltaS) - Math.abs(a.deltaS))
        .slice(0, WORST_N),
    };
  });
}

/**
 * Loads LocalTimes for every stored activity linked to a run. Stream choice per
 * flag: the `moving` flag only ever comes from a Strava stream; for
 * derived_moving prefer the Strava stream too (same time axis as Strava's own
 * moving_time), else any stream that has it.
 */
export async function loadRunReconciliationInputs(): Promise<LocalTimes[]> {
  const { rows } = await query<{
    strava_activity_id: string;
    date: string;
    distance_km: string;
    moving_time_s: number;
    elapsed_time_s: number;
    duration_s: number | null;
    time_s: number[] | null;
    moving: Array<boolean | null> | null;
    derived_moving: Array<boolean | null> | null;
  }>(
    `SELECT t.strava_activity_id, r.date::text AS date, r.distance_km,
            t.moving_time_s, t.elapsed_time_s, r.duration_s,
            s.time_s, s.moving, s.derived_moving
       FROM public.strava_activity_times t
       JOIN public.runs r ON r.id = t.run_id
       LEFT JOIN LATERAL (
         SELECT time_s, moving, derived_moving
           FROM public.run_streams rs
          WHERE rs.run_id = r.id
          ORDER BY (rs.source = 'strava') DESC,
                   (rs.derived_moving IS NOT NULL) DESC
          LIMIT 1
       ) s ON TRUE
      ORDER BY r.date`,
  );
  return rows.map((r) => ({
    label: `${r.date} ${Number(r.distance_km).toFixed(2)}km (strava ${r.strava_activity_id})`,
    stravaMovingS: r.moving_time_s,
    stravaElapsedS: r.elapsed_time_s,
    durationS: r.duration_s,
    timeS: r.time_s?.map(Number) ?? null,
    moving: r.moving,
    derivedMoving: r.derived_moving,
  }));
}
