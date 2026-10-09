import {
  dataPointListSchema,
  exportTcxResponseSchema,
  heartRateListSchema,
  wellnessDataPointListSchema,
  dailyRollUpResponseSchema,
  type DataPointList,
  type HeartRateList,
  type WellnessDataPointList,
  type CivilDateTime,
  type DailyRollUpResponse,
} from './types';

// Thin, typed HTTP client for the Google Health API v4 endpoints the run adapter
// needs. Functions take an access token explicitly (the OAuth module owns token
// lifecycle) and parse every JSON response through the zod schemas. `fetch` is
// the Node global; tests stub it. Mirrors services/strava/client.ts.

const API_BASE = 'https://health.googleapis.com/v4';
// The API addresses the authenticated user as `users/me`; `exercise` is the
// dataType endpoint identifier for exercise sessions.
// TODO(live): confirm `users/me` is accepted (vs. a concrete user id) and that
// `exercise` is the correct dataType path segment.
const USER = 'me';
const EXERCISE_DATA_TYPE = 'exercise';

/** Thrown on HTTP 429 so the caller can stop the sync instead of hammering. */
export class GoogleHealthRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleHealthRateLimitError';
  }
}

function rateLimited(res: Response): boolean {
  return res.status === 429;
}

async function ghGet(path: string, accessToken: string): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (rateLimited(res)) {
    throw new GoogleHealthRateLimitError(
      `google-health: rate limit hit on ${path} (HTTP 429) — back off and resume later`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `google-health: GET ${path} failed (${res.status} ${res.statusText}) ${text}`,
    );
  }
  return res;
}

async function ghPost(
  path: string,
  accessToken: string,
  body: unknown,
): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (rateLimited(res)) {
    throw new GoogleHealthRateLimitError(
      `google-health: rate limit hit on ${path} (HTTP 429) — back off and resume later`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `google-health: POST ${path} failed (${res.status} ${res.statusText}) ${text}`,
    );
  }
  return res;
}

export interface ListExerciseParams {
  pageSize?: number;
  pageToken?: string;
}

/**
 * One page of the user's exercise sessions (the `exercise` dataType dataPoints).
 *
 * Deliberately UNFILTERED. The exercise dataType has no server-side start-time
 * filter we could get to parse: verified live 2026-08-01 that `start_time > "…"`
 * (and every qualified variant tried — `exercise.interval.start_time`,
 * `civil_start_time`, `start_time.physical_time`, …) returns
 * INVALID_DATA_POINT_FILTER. Unlike the heart-rate measurement type (which does
 * accept `heart_rate.sample_time.physical_time`), sessions expose no comparable
 * time member. So the incremental-sync watermark is applied CLIENT-SIDE in the
 * ingest loop instead (see services/googleHealth/ingest.ts) — cheap here, ~100
 * sessions over 1–2 pages, and it removes the dependency on an unverified grammar.
 */
export async function listExerciseSessionsPage(
  accessToken: string,
  { pageSize, pageToken }: ListExerciseParams = {},
): Promise<DataPointList> {
  const qs = new URLSearchParams();
  if (pageSize !== undefined) qs.set('pageSize', String(pageSize));
  if (pageToken !== undefined) qs.set('pageToken', pageToken);
  const path = `/users/${USER}/dataTypes/${EXERCISE_DATA_TYPE}/dataPoints?${qs.toString()}`;
  const res = await ghGet(path, accessToken);
  return dataPointListSchema.parse(await res.json());
}

export interface HeartRateWindowParams {
  /** RFC-3339 inclusive lower bound of the sample window. */
  startTime: string;
  /** RFC-3339 exclusive upper bound. */
  endTime: string;
  pageToken?: string;
  pageSize?: number;
}

/**
 * One page of `heart-rate` samples within a time window. Verified live
 * 2026-07-24: measurement data types (unlike session types) require the
 * FULLY-QUALIFIED field path `heart_rate.sample_time.physical_time` with the `>=`
 * / `<` operators — a bare `start_time` filter returns
 * INVALID_DATA_POINT_FILTER_RESTRICTION_COMPARABLE. Samples come newest-first;
 * the caller re-sorts. Used to attach Fitbit wrist HR to a run.
 */
export async function listHeartRateSamplesPage(
  accessToken: string,
  { startTime, endTime, pageToken, pageSize }: HeartRateWindowParams,
): Promise<HeartRateList> {
  const qs = new URLSearchParams();
  qs.set('pageSize', String(pageSize ?? 1000));
  if (pageToken !== undefined) qs.set('pageToken', pageToken);
  qs.set(
    'filter',
    `heart_rate.sample_time.physical_time >= "${startTime}" AND ` +
      `heart_rate.sample_time.physical_time < "${endTime}"`,
  );
  const path = `/users/${USER}/dataTypes/heart-rate/dataPoints?${qs.toString()}`;
  const res = await ghGet(path, accessToken);
  return heartRateListSchema.parse(await res.json());
}

export interface ListDataPointsParams {
  /** kebab dataType id, e.g. 'steps', 'sleep', 'daily-resting-heart-rate'. */
  dataType: string;
  /**
   * Pre-built `filter` expression. The grammar differs by dataType kind and is
   * built by the caller (services/googleHealth/wellness.ts filter helpers):
   * sessions filter on `start_time`, measurements on the fully-qualified
   * `<field>.sample_time.physical_time` (verified for heart-rate), interval/daily
   * types on their own field path (TODO(live)). Omitted → unfiltered (all pages).
   */
  filter?: string;
  pageSize?: number;
  pageToken?: string;
}

/**
 * One page of an arbitrary dataType's dataPoints (the generic list endpoint reused
 * for every wellness pull: steps/distance/floors/active-minutes/calories, sleep,
 * daily-resting-heart-rate, daily-heart-rate-variability). The envelope is parsed
 * strictly; each point's per-type value stays a passthrough the mapper reaches into
 * (see wellnessDataPointSchema). Shares ghGet's 429 → GoogleHealthRateLimitError.
 */
export async function listDataPointsPage(
  accessToken: string,
  { dataType, filter, pageSize, pageToken }: ListDataPointsParams,
): Promise<WellnessDataPointList> {
  const qs = new URLSearchParams();
  qs.set('pageSize', String(pageSize ?? 1000));
  if (pageToken !== undefined) qs.set('pageToken', pageToken);
  if (filter !== undefined) qs.set('filter', filter);
  const path = `/users/${USER}/dataTypes/${dataType}/dataPoints?${qs.toString()}`;
  const res = await ghGet(path, accessToken);
  return wellnessDataPointListSchema.parse(await res.json());
}

/**
 * Export a single exercise session as a TCX document (route + per-sample HR /
 * distance / altitude). The route/sample series are NOT embedded in the session
 * data point, so this is the documented way to reach them.
 *
 * `dataPointName` is the DataPoint resource path
 * (`users/me/dataTypes/exercise/dataPoints/{id}`). Returns the TCX XML string, or
 * '' when the run has no exportable track.
 *
 * Verified live 2026-07-24: the response is JSON `{ "tcxData": "<xml>" }`, not a
 * raw XML body — so we unwrap `tcxData` here. A run with no route (e.g. Fitbit Air
 * without a phone-recorded track) returns a TCX whose <Activity> has no
 * <Trackpoint>s; the parser (streams.ts) yields no series for it. The route also
 * needs the `googlehealth.location.readonly` scope (see google-health-auth.ts).
 * We fall back to a raw body if the envelope ever changes shape.
 */
export async function exportExerciseTcx(
  accessToken: string,
  dataPointName: string,
): Promise<string> {
  const res = await ghGet(`/${dataPointName}:exportExerciseTcx`, accessToken);
  const body = await res.text();
  if (!body) return '';
  try {
    return exportTcxResponseSchema.parse(JSON.parse(body)).tcxData ?? '';
  } catch {
    return body; // not JSON → assume a raw-XML body
  }
}

export interface DailyRollUpParams {
  /** kebab dataType id: 'steps' | 'distance' | 'floors' | 'total-calories'. */
  dataType: string;
  /** Closed-open civil-date range (`end` exclusive), per Google's docs. */
  range: { start: CivilDateTime; end: CivilDateTime };
  /** Aggregation window in days; defaults to 1 (one point per calendar day). */
  windowSizeDays?: number;
  pageToken?: string;
  pageSize?: number;
}

/**
 * Daily rollup for one dataType — the correct daily-TOTAL source for steps /
 * distance / floors / total-calories (see types.ts for why List can't sum these).
 * Range caps per Google's docs: 14 days for `total-calories`
 * (calories-in-heart-rate-zone/heart-rate/active-minutes share the cap but aren't
 * pulled this way), 90 days for everything else — callers must chunk long ranges
 * (see wellnessMap.ts `chunkLocalDayRange`).
 */
export async function dailyRollUp(
  accessToken: string,
  { dataType, range, windowSizeDays, pageToken, pageSize }: DailyRollUpParams,
): Promise<DailyRollUpResponse> {
  const res = await ghPost(
    `/users/${USER}/dataTypes/${dataType}/dataPoints:dailyRollUp`,
    accessToken,
    {
      range,
      windowSizeDays: windowSizeDays ?? 1,
      ...(pageSize !== undefined ? { pageSize } : {}),
      ...(pageToken !== undefined ? { pageToken } : {}),
    },
  );
  return dailyRollUpResponseSchema.parse(await res.json());
}
