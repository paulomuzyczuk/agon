import { DATA_SOURCES } from './constants';

// Activity source priority (MZY-225). When the same physical run or ride reaches
// Postgres from more than one source, ONE row is canonical, chosen by a fixed,
// athlete-decided ranking (2026-09-28):
//
//   1. Agon itself       — live_recording, manual, telegram
//   2. Strava / exports  — strava (while Premium API access is on), strava_export,
//                          garmin_export, samsung_export, polar
//   3. Google Health     — google_health
//
// Every ingest path (Strava, Google Health, file import, live recording — runs
// and rides alike) asks this module what to do with an incoming activity that
// overlaps a stored one. Pure + deterministic so the policy is unit-tested once;
// the DB side (finding overlaps, merging the loser) is services/activitySources.ts.

export type SourceTier = 1 | 2 | 3;

const TIER_BY_SOURCE: Record<string, SourceTier> = {
  [DATA_SOURCES.LIVE_RECORDING]: 1,
  [DATA_SOURCES.MANUAL]: 1,
  [DATA_SOURCES.TELEGRAM]: 1,
  [DATA_SOURCES.STRAVA]: 2,
  [DATA_SOURCES.STRAVA_EXPORT]: 2,
  [DATA_SOURCES.GARMIN_EXPORT]: 2,
  [DATA_SOURCES.SAMSUNG_EXPORT]: 2,
  [DATA_SOURCES.POLAR]: 2,
  [DATA_SOURCES.GOOGLE_HEALTH]: 3,
};

/**
 * A source's priority tier — LOWER wins. An unknown source is treated as a
 * device export (tier 2): it neither overrides Agon's own records nor gets
 * silently replaced by the passive Google Health feed.
 */
export function sourceTier(source: string): SourceTier {
  return TIER_BY_SOURCE[source] ?? 2;
}

/**
 * Max start-time gap for a supersede. Interval overlap alone is too loose to
 * justify DELETING a row: a long activity's window can overlap a separate short
 * one that started much later (seen 2026-07-23, services/strava/matchEnrich.ts).
 * The same activity on two apps starts within seconds of itself; 5 min is generous.
 */
export const SUPERSEDE_MAX_START_DELTA_MS = 300_000;

export interface StoredActivity {
  id: string;
  source: string;
  startedAtMs: number;
}

export interface OverlapPartition {
  /**
   * Stored activities of equal or higher priority. Any of these means the
   * incoming record is a twin of something at least as authoritative → skip it.
   * Sorted best-first (tier, then earliest start).
   */
  blocking: StoredActivity[];
  /** Lower-priority twins the incoming record replaces (merged into it, then deleted). */
  supersede: StoredActivity[];
  /**
   * Lower-priority rows that overlap but start too far apart to be sure they're
   * the same activity. Left untouched — the caller logs them for a human look.
   */
  ambiguous: StoredActivity[];
}

/**
 * Split the stored activities overlapping an incoming record by what the
 * incoming record should do about each. Skipping on ANY equal-or-higher overlap
 * keeps the long-standing "never insert a twin" guard; replacing needs the
 * stricter start-time match because it deletes a row.
 */
export function partitionOverlaps(
  incoming: { source: string; startedAtMs: number },
  stored: StoredActivity[],
): OverlapPartition {
  const tier = sourceTier(incoming.source);
  const blocking: StoredActivity[] = [];
  const supersede: StoredActivity[] = [];
  const ambiguous: StoredActivity[] = [];

  for (const s of stored) {
    if (sourceTier(s.source) <= tier) blocking.push(s);
    else if (
      Math.abs(s.startedAtMs - incoming.startedAtMs) <=
      SUPERSEDE_MAX_START_DELTA_MS
    )
      supersede.push(s);
    else ambiguous.push(s);
  }

  blocking.sort(
    (a, b) =>
      sourceTier(a.source) - sourceTier(b.source) ||
      a.startedAtMs - b.startedAtMs,
  );
  return { blocking, supersede, ambiguous };
}
