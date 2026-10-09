import { z } from 'zod';
import { StravaRateLimitError } from './client';
import { query } from '../db';

// Strava best-efforts: the paywall-only per-distance splits Strava computes for
// each run. Only the DETAILED activity endpoint carries them
// (`GET /activities/{id}?include_all_efforts=true` → `best_efforts[]`); the
// summary list (client.ts) does not, so this is a separate per-activity call —
// heavier on the rate limit, run behind the one-time reference pull script.
//
// A one-time reference pull (Strava is not a live source). We store every
// activity's efforts raw in public.strava_best_efforts; the PR-per-distance
// rollup is a dbt mart (analytics.fct_run_best_efforts), not computed here.

const API_BASE = 'https://www.strava.com/api/v3';

// One entry of the detailed activity's best_efforts array. Strava returns many
// more fields (segment/achievement metadata); we keep only what the PR analysis
// needs. distance is metres; times are seconds.
const bestEffortSchema = z.object({
  name: z.string(),
  distance: z.number().nonnegative(),
  elapsed_time: z.number().int().nonnegative(),
  moving_time: z.number().int().nonnegative().optional(),
  pr_rank: z.number().int().nullable().optional(),
  start_date: z.string().optional(),
});

// The slice of the detailed activity we read. best_efforts is present only for
// runs (and only once Strava has computed them); absent → treat as no efforts.
const detailedActivitySchema = z.object({
  id: z.number().int(),
  start_date: z.string().optional(),
  best_efforts: z.array(bestEffortSchema).nullable().optional(),
});

/** One best effort, normalized for storage + the pure PR rollup. */
export interface StravaBestEffort {
  activityId: number;
  name: string;
  distanceM: number;
  elapsedTimeS: number;
  movingTimeS: number | null;
  prRank: number | null;
  /** effort start (UTC ISO), or null when Strava omitted it. */
  startedAt: string | null;
  /** parent activity start (UTC ISO) — used to date the PR. */
  activityStartedAt: string | null;
}

/**
 * Fetch the best_efforts for one activity. Returns [] when the activity has no
 * efforts (not a run, or Strava hasn't computed them) or 404s. Throws
 * StravaRateLimitError on 429 so the caller can stop and resume — the detailed
 * endpoint is the rate-limit-heavy part of the pull.
 */
export async function fetchActivityBestEfforts(
  accessToken: string,
  activityId: number,
): Promise<StravaBestEffort[]> {
  const res = await fetch(
    `${API_BASE}/activities/${activityId}?include_all_efforts=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (res.status === 429) {
    throw new StravaRateLimitError(
      `strava: rate limit hit fetching best efforts for ${activityId} (HTTP 429)`,
    );
  }
  if (res.status === 404) return [];
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `strava: detailed activity ${activityId} failed (${res.status} ${res.statusText}) ${text}`,
    );
  }

  const activity = detailedActivitySchema.parse(await res.json());
  const activityStartedAt = activity.start_date
    ? new Date(activity.start_date).toISOString()
    : null;
  return (activity.best_efforts ?? [])
    .filter((e) => e.distance > 0 && e.elapsed_time > 0)
    .map((e) => ({
      activityId,
      name: e.name,
      distanceM: e.distance,
      elapsedTimeS: e.elapsed_time,
      movingTimeS: e.moving_time ?? null,
      prRank: e.pr_rank ?? null,
      startedAt: e.start_date ? new Date(e.start_date).toISOString() : null,
      activityStartedAt,
    }));
}

/**
 * Pure: reduce a flat list of efforts (across many activities) to the athlete's
 * PR at each named distance — the fastest elapsed split per `name`. Ties keep the
 * first seen. Returned sorted by distance ascending (400m → Marathon). This is
 * what the dbt mart derives too; kept here so the dry-run report can show the PR
 * table before any write.
 */
export function pickPrPerDistance(
  efforts: StravaBestEffort[],
): StravaBestEffort[] {
  const best = new Map<string, StravaBestEffort>();
  for (const e of efforts) {
    const cur = best.get(e.name);
    if (!cur || e.elapsedTimeS < cur.elapsedTimeS) best.set(e.name, e);
  }
  return [...best.values()].sort((a, b) => a.distanceM - b.distanceM);
}

/** Activity ids already stored — lets the pull skip them (resumable, 429-safe). */
export async function getStoredBestEffortActivityIds(): Promise<Set<number>> {
  const { rows } = await query<{ strava_activity_id: string }>(
    `SELECT DISTINCT strava_activity_id FROM public.strava_best_efforts`,
  );
  return new Set(rows.map((r) => Number(r.strava_activity_id)));
}

/**
 * Idempotent upsert of one activity's efforts, keyed on
 * (strava_activity_id, effort_name). Re-running refreshes the same effort in
 * place (Strava may recompute), never duplicates. Returns rows written.
 */
export async function upsertActivityBestEfforts(
  efforts: StravaBestEffort[],
): Promise<number> {
  let written = 0;
  for (const e of efforts) {
    await query(
      `INSERT INTO public.strava_best_efforts
         (strava_activity_id, effort_name, distance_m, elapsed_time_s,
          moving_time_s, pr_rank, started_at, activity_started_at, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'strava')
       ON CONFLICT (strava_activity_id, effort_name) DO UPDATE SET
         distance_m          = EXCLUDED.distance_m,
         elapsed_time_s      = EXCLUDED.elapsed_time_s,
         moving_time_s       = EXCLUDED.moving_time_s,
         pr_rank             = EXCLUDED.pr_rank,
         started_at          = EXCLUDED.started_at,
         activity_started_at = EXCLUDED.activity_started_at,
         captured_at         = now()`,
      [
        e.activityId,
        e.name,
        e.distanceM,
        e.elapsedTimeS,
        e.movingTimeS,
        e.prRank,
        e.startedAt,
        e.activityStartedAt,
      ],
    );
    written++;
  }
  return written;
}
