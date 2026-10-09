import {
  fitbitIntradayHrSchema,
  fitbitDailySummarySchema,
  fitbitSleepSchema,
  fitbitHrvSchema,
  type FitbitDailySummary,
  type FitbitSleepLog,
  type FitbitHrv,
} from './types';

// Typed client for the Fitbit Web API endpoints the physical-activity backfill
// needs. Accept-Language 'en_GB' forces the METRIC unit system so distances come
// back in km regardless of the account's locale. Fitbit's rate limit is
// 150 req/hour/user; a 429 surfaces as FitbitRateLimitError so the caller stops.

const API_BASE = 'https://api.fitbit.com';

export class FitbitRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FitbitRateLimitError';
  }
}

async function fitbitGet(path: string, accessToken: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Accept-Language': 'en_GB', // metric (km)
    },
  });
  if (res.status === 429) {
    throw new FitbitRateLimitError(
      `fitbit: rate limit hit on ${path} (HTTP 429) — back off and resume later`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `fitbit: GET ${path} failed (${res.status} ${res.statusText}) ${text}`,
    );
  }
  return res.json();
}

export interface IntradayHrSample {
  time: string; // local "HH:mm:ss"
  value: number; // bpm
}

/**
 * Intraday (per-second) heart rate for a local date + time window. Returns the
 * dataset (possibly empty if no HR was recorded in the window).
 */
export async function getIntradayHeartRate(
  accessToken: string,
  date: string, // YYYY-MM-DD (local)
  startHHmm: string, // "HH:mm"
  endHHmm: string, // "HH:mm"
): Promise<IntradayHrSample[]> {
  const json = await fitbitGet(
    `/1/user/-/activities/heart/date/${date}/1d/1sec/time/${startHHmm}/${endHHmm}.json`,
    accessToken,
  );
  return fitbitIntradayHrSchema.parse(json)['activities-heart-intraday']
    .dataset;
}

/** Daily activity summary (steps, floors, active minutes, calories, resting HR). */
export async function getDailyActivitySummary(
  accessToken: string,
  date: string,
): Promise<FitbitDailySummary['summary']> {
  const json = await fitbitGet(
    `/1/user/-/activities/date/${date}.json`,
    accessToken,
  );
  return fitbitDailySummarySchema.parse(json).summary;
}

/** Sleep logs over an inclusive local date range (main sleep + naps). */
export async function getSleepLogs(
  accessToken: string,
  startDate: string,
  endDate: string,
): Promise<FitbitSleepLog[]> {
  const json = await fitbitGet(
    `/1.2/user/-/sleep/date/${startDate}/${endDate}.json`,
    accessToken,
  );
  return fitbitSleepSchema.parse(json).sleep;
}

/** Daily HRV (RMSSD) over an inclusive date range. */
export async function getHrv(
  accessToken: string,
  startDate: string,
  endDate: string,
): Promise<FitbitHrv['hrv']> {
  const json = await fitbitGet(
    `/1/user/-/hrv/date/${startDate}/${endDate}.json`,
    accessToken,
  );
  return fitbitHrvSchema.parse(json).hrv;
}
