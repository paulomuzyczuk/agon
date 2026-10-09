import { z } from 'zod';

// Zod schemas for the slice of the Fitbit Web API we consume. Every response is
// parsed through these at the network boundary.

// POST https://api.fitbit.com/oauth2/token (auth-code exchange AND refresh).
export const fitbitTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number().int(), // seconds until access_token expiry
  token_type: z.string(),
  scope: z.string().optional(),
  user_id: z.string(), // Fitbit user id ("encoded id")
});
export type FitbitTokenResponse = z.infer<typeof fitbitTokenResponseSchema>;

// GET /1/user/-/activities/heart/date/{date}/1d/1sec/time/{start}/{end}.json
// The intraday dataset: one entry per sample, time as local "HH:mm:ss".
export const fitbitIntradayHrSchema = z.object({
  'activities-heart-intraday': z.object({
    dataset: z.array(z.object({ time: z.string(), value: z.number() })),
    datasetInterval: z.number().optional(),
    datasetType: z.string().optional(),
  }),
});
export type FitbitIntradayHr = z.infer<typeof fitbitIntradayHrSchema>;

// GET /1/user/-/activities/date/{date}.json — daily activity summary. Distances
// is an array of { activity, distance }; we read the 'total' entry.
export const fitbitDailySummarySchema = z.object({
  summary: z.object({
    steps: z.number().optional(),
    floors: z.number().optional(),
    caloriesOut: z.number().optional(),
    sedentaryMinutes: z.number().optional(),
    lightlyActiveMinutes: z.number().optional(),
    fairlyActiveMinutes: z.number().optional(),
    veryActiveMinutes: z.number().optional(),
    restingHeartRate: z.number().optional(),
    distances: z
      .array(z.object({ activity: z.string(), distance: z.number() }))
      .optional(),
  }),
});
export type FitbitDailySummary = z.infer<typeof fitbitDailySummarySchema>;

// GET /1.2/user/-/sleep/date/{start}/{end}.json — sleep logs. `levels.summary`
// is keyed by stage name (deep/light/rem/wake for staged devices, or
// asleep/restless/awake for older "classic" logs), each with a `minutes`.
const sleepStageSchema = z
  .object({ minutes: z.number().optional() })
  .passthrough();
export const fitbitSleepSchema = z.object({
  sleep: z.array(
    z
      .object({
        logId: z.number(),
        dateOfSleep: z.string(),
        startTime: z.string(),
        endTime: z.string(),
        efficiency: z.number().optional(),
        minutesAsleep: z.number().optional(),
        minutesAwake: z.number().optional(),
        timeInBed: z.number().optional(),
        isMainSleep: z.boolean().optional(),
        type: z.string().optional(),
        levels: z
          .object({ summary: z.record(sleepStageSchema).optional() })
          .partial()
          .optional(),
      })
      .passthrough(),
  ),
});
export type FitbitSleep = z.infer<typeof fitbitSleepSchema>;
export type FitbitSleepLog = FitbitSleep['sleep'][number];

// GET /1/user/-/hrv/date/{start}/{end}.json — daily HRV (RMSSD, ms).
export const fitbitHrvSchema = z.object({
  hrv: z.array(
    z.object({
      dateTime: z.string(), // YYYY-MM-DD
      value: z.object({
        dailyRmssd: z.number().optional(),
        deepRmssd: z.number().optional(),
      }),
    }),
  ),
});
export type FitbitHrv = z.infer<typeof fitbitHrvSchema>;
