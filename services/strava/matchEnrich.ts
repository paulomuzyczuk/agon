// Match a Strava activity to an EXISTING run row by time overlap.
//
// Context (2026-08-01): the athlete's runs are all source='google_health' — thin
// on GPS/elevation (the Fitbit Air has no GPS chip, the phone rarely recorded a
// track) and route-less, so weather enrichment never fires. A one-month Strava
// premium gift reopened API access, and Strava holds the rich FIT-derived data
// (GPS start, elevation, HR/pace/altitude/cadence streams) for the same runs.
//
// Running the generic Strava backfill would INSERT parallel source='strava' runs
// — the exact duplication the Google Health dedupe was built to avoid. Instead we
// MATCH each Strava activity to the run we already have (by overlapping time
// interval, the same idea as googleHealth/dedupe.ts) and enrich that row in
// place. This module is the pure, unit-testable matcher; the I/O orchestration
// lives in scripts/enrich-runs-from-strava.ts.

/** Overlap slack (seconds). A touch wider than the dedupe's 60 s to absorb any
 * small clock difference between Strava's start_date and the Health-Connect
 * record's start time for the same physical run. */
export const MATCH_SLACK_S = 120;

/**
 * Hard bound on the start-time gap for a match. Interval overlap alone is too
 * loose: a long run's wide elapsed_time window can "overlap" a short run that
 * started 45 min later (seen in the 2026-07-23 dry run). The same physical run
 * recorded on two apps starts within seconds of itself, so 5 min is generous.
 */
export const MAX_START_DELTA_S = 300;

/** The minimal shape of an existing run needed to match + score. */
export interface ExistingRunLite {
  id: string;
  startedAtMs: number;
  durationS: number;
  distanceKm: number;
}

/** The minimal shape of a Strava activity needed to match + score. */
export interface StravaActivityLite {
  id: number;
  startMs: number;
  /** elapsed_time (the wider window) so a paused run still overlaps its record. */
  durationS: number;
  distanceKm: number;
}

export interface ActivityMatch {
  run: ExistingRunLite;
  /** |activity start − run start|, seconds — the tie-breaker + a sanity signal. */
  startDeltaS: number;
  /** (activity − run) / run distance, percent. Null when the run has no distance.
   * A large magnitude flags a suspicious match to eyeball, never auto-rejects. */
  distDeltaPct: number | null;
}

function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  const slack = MATCH_SLACK_S * 1000;
  return aStart < bEnd + slack && aEnd > bStart - slack;
}

/**
 * Best existing run for a Strava activity: the time-overlapping run with the
 * smallest start-time delta (runs never overlap each other, so this is
 * unambiguous in practice). Returns null when nothing overlaps — that activity
 * has no run in the DB (a Strava-only or post-last-sync run).
 */
export function matchActivity(
  activity: StravaActivityLite,
  runs: readonly ExistingRunLite[],
): ActivityMatch | null {
  const aStart = activity.startMs;
  const aEnd = activity.startMs + activity.durationS * 1000;

  let best: ExistingRunLite | null = null;
  let bestDeltaMs = Infinity;
  for (const r of runs) {
    const rStart = r.startedAtMs;
    const rEnd = r.startedAtMs + r.durationS * 1000;
    if (!overlaps(aStart, aEnd, rStart, rEnd)) continue;
    const delta = Math.abs(aStart - rStart);
    if (delta > MAX_START_DELTA_S * 1000) continue; // too far apart to be the same run
    if (delta < bestDeltaMs) {
      bestDeltaMs = delta;
      best = r;
    }
  }
  if (!best) return null;

  const distDeltaPct =
    best.distanceKm > 0
      ? ((activity.distanceKm - best.distanceKm) / best.distanceKm) * 100
      : null;
  return { run: best, startDeltaS: Math.round(bestDeltaMs / 1000), distDeltaPct };
}
