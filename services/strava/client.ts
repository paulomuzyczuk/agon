import {
  stravaActivityListSchema,
  stravaGearSchema,
  type StravaSummaryActivity,
} from './types';

// Thin, typed HTTP client for the Strava API v3 endpoints the backfill needs.
// Functions take an access token explicitly (the OAuth module owns token
// lifecycle) and parse every response through the zod schemas. `fetch` is the
// Node global; tests stub it.

const API_BASE = 'https://www.strava.com/api/v3';

/** Thrown on HTTP 429 so the caller can stop the backfill instead of hammering. */
export class StravaRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StravaRateLimitError';
  }
}

async function stravaGet(path: string, accessToken: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 429) {
    throw new StravaRateLimitError(
      `strava: rate limit hit on ${path} (HTTP 429) — back off and resume later`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `strava: GET ${path} failed (${res.status} ${res.statusText}) ${text}`,
    );
  }
  return res.json();
}

export interface ListActivitiesParams {
  page: number;
  perPage: number;
  /** epoch seconds — only activities before this time (exclusive). */
  before?: number;
  /** epoch seconds — only activities after this time (exclusive). */
  after?: number;
}

/** One page of the athlete's activities, newest first. */
export async function listActivitiesPage(
  accessToken: string,
  { page, perPage, before, after }: ListActivitiesParams,
): Promise<StravaSummaryActivity[]> {
  const qs = new URLSearchParams({
    page: String(page),
    per_page: String(perPage),
  });
  if (before !== undefined) qs.set('before', String(before));
  if (after !== undefined) qs.set('after', String(after));
  const json = await stravaGet(
    `/athlete/activities?${qs.toString()}`,
    accessToken,
  );
  return stravaActivityListSchema.parse(json);
}

/** Resolve a gear_id (e.g. 'g1234567') to its display name (the shoe model). */
export async function getGearName(
  accessToken: string,
  gearId: string,
): Promise<string> {
  const json = await stravaGet(`/gear/${gearId}`, accessToken);
  return stravaGearSchema.parse(json).name;
}
