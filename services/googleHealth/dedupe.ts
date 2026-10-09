import type { ExerciseDataPoint } from './types';
import { parseDurationSeconds } from './mapper';

// Dedupe overlapping Google Health exercise records down to one canonical run.
//
// Why: Google Health often holds the SAME run twice — a `health_connect` record
// (a phone app / Samsung / Strava via Android Health Connect, which matches the
// athlete's SOT to the metre) AND a `fitbit` record (the Fitbit Air's passive
// auto-detection, same run but drifting duration and usually no HR). Verified
// 2026-07-24 by diffing 97 Google Health runs against the SOT sheet: deduping by
// overlapping time interval and preferring health_connect reproduced the SOT set
// (69/72 shared-day distances within 50 m, median Δ 4 m).
//
// Pure + deterministic (no I/O) so the ingest orchestrator stays thin and this is
// unit-testable. The Fitbit HR that the dropped duplicate carried is NOT lost —
// it's re-attached separately from the granular `heart-rate` dataType by time
// window (see heartRate.ts), so the canonical run keeps SOT-accurate distance and
// duration while still getting Fitbit HR.

/** Overlap slack (seconds): treat records within a minute as the same activity. */
const OVERLAP_SLACK_S = 60;

export interface RunInterval {
  startMs: number;
  endMs: number;
}

/**
 * The [start, end] instants of a session, in epoch ms. End is start +
 * activeDuration when available, else the interval's endTime. Returns null when
 * neither is resolvable (such a record can't be time-deduped).
 */
export function sessionInterval(dp: ExerciseDataPoint): RunInterval | null {
  const startMs = Date.parse(dp.exercise.interval.startTime);
  if (!Number.isFinite(startMs)) return null;
  const active = parseDurationSeconds(dp.exercise.activeDuration);
  if (active != null && active > 0) {
    return { startMs, endMs: startMs + active * 1000 };
  }
  const endMs = dp.exercise.interval.endTime
    ? Date.parse(dp.exercise.interval.endTime)
    : NaN;
  if (Number.isFinite(endMs) && endMs > startMs) return { startMs, endMs };
  return null;
}

function overlaps(a: RunInterval, b: RunInterval): boolean {
  const slack = OVERLAP_SLACK_S * 1000;
  return a.startMs < b.endMs + slack && a.endMs > b.startMs - slack;
}

/**
 * Preference rank for the canonical record within an overlap group — LOWER wins.
 * 1) health_connect (SOT-accurate) over anything else (fitbit auto-detect).
 * 2) an actively-measured session (user pressed start) over passive.
 * 3) longer distance (the fuller record of the same run).
 */
function rank(dp: ExerciseDataPoint): [number, number, number] {
  const platform = dp.dataSource?.platform?.toUpperCase();
  const method = dp.dataSource?.recordingMethod?.toUpperCase();
  const dist = dp.exercise.metricsSummary?.distanceMillimeters ?? 0;
  return [
    platform === 'HEALTH_CONNECT' ? 0 : 1,
    method === 'ACTIVELY_MEASURED' ? 0 : 1,
    -dist,
  ];
}

function rankLess(
  a: [number, number, number],
  b: [number, number, number],
): boolean {
  return a[0] !== b[0]
    ? a[0] < b[0]
    : a[1] !== b[1]
      ? a[1] < b[1]
      : a[2] < b[2];
}

export interface DedupeResult {
  /** One canonical record per real run, best-ranked within its overlap group. */
  canonical: ExerciseDataPoint[];
  /** How many records were dropped as duplicates of a kept one. */
  dropped: number;
}

/**
 * Collapse a batch of exercise records to one canonical run per overlapping
 * time interval. Records with no resolvable interval are passed through untouched
 * (they can't be time-grouped, so they're kept as-is). Order-independent: groups
 * are formed by interval overlap, then the best-ranked member of each is kept.
 */
export function dedupeRuns(dps: ExerciseDataPoint[]): DedupeResult {
  const groups: { interval: RunInterval; members: ExerciseDataPoint[] }[] = [];
  const noInterval: ExerciseDataPoint[] = [];

  for (const dp of dps) {
    const iv = sessionInterval(dp);
    if (!iv) {
      noInterval.push(dp);
      continue;
    }
    const g = groups.find((grp) => overlaps(grp.interval, iv));
    if (g) {
      g.members.push(dp);
      g.interval = {
        startMs: Math.min(g.interval.startMs, iv.startMs),
        endMs: Math.max(g.interval.endMs, iv.endMs),
      };
    } else {
      groups.push({ interval: iv, members: [dp] });
    }
  }

  let dropped = 0;
  const canonical: ExerciseDataPoint[] = [];
  for (const g of groups) {
    let best = g.members[0]!;
    for (const m of g.members.slice(1)) {
      if (rankLess(rank(m), rank(best))) best = m;
    }
    canonical.push(best);
    dropped += g.members.length - 1;
  }
  return { canonical: [...canonical, ...noInterval], dropped };
}
