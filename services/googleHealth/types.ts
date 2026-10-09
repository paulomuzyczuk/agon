import { z } from 'zod';

// Zod schemas for the slice of the Google Health API v4 we consume. Validation
// happens at the network boundary (sihha convention: never trust an external
// payload). Unknown fields are stripped/passed through — the API returns many
// columns we don't model.
//
// Verified live against real payloads 2026-07-24 (see docs/run-ingestion-migration
// .md Progress). Confirmed then: `exerciseType` is a bare "RUNNING"; the route
// needs the separate `location` scope; `exportExerciseTcx` returns JSON-wrapped
// `tcxData`; metricsSummary carries no elevation/max-HR for Fitbit-Air runs.
// `.passthrough()` keeps us tolerant of extra fields; the int64-as-string coercion
// below matches Google's JSON mapping for 64-bit ints (bpm/steps come as strings).

/** Google's JSON mapping encodes int64 as a STRING; accept either and coerce. */
const int64Number = z
  .union([z.number(), z.string()])
  .transform((v) => Number(v));

// POST https://oauth2.googleapis.com/token (auth-code exchange AND refresh).
// refresh_token is present ONLY on the first consent (access_type=offline &
// prompt=consent); a refresh response omits it, so it's optional here.
export const googleTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().int(), // seconds until access_token expiry
  token_type: z.string(),
  scope: z.string().optional(),
  id_token: z.string().optional(), // present with the openid scope; unused
});
export type GoogleTokenResponse = z.infer<typeof googleTokenResponseSchema>;

// A SessionTimeInterval: RFC-3339 start/end plus per-boundary UTC offsets encoded
// as protobuf Durations ("7200s"). The offset lets us derive the athlete-local
// date without depending on a hard-coded timezone.
export const sessionTimeIntervalSchema = z.object({
  startTime: z.string(), // RFC-3339 UTC instant
  endTime: z.string().optional(),
  startUtcOffset: z.string().optional(), // Duration, e.g. "7200s" for UTC+2
  endUtcOffset: z.string().optional(),
});
export type SessionTimeInterval = z.infer<typeof sessionTimeIntervalSchema>;

// Exercise.MetricsSummary — the aggregates we map onto a `runs` row. All optional:
// a treadmill run has no speed/route; HR is absent when no strap/wrist HR exists.
export const metricsSummarySchema = z
  .object({
    distanceMillimeters: z.number().nonnegative().optional(),
    elevationGainMillimeters: z.number().optional(),
    averageHeartRateBeatsPerMinute: int64Number.optional(),
    maxHeartRateBeatsPerMinute: int64Number.optional(), // absent on Fitbit-Air runs; filled from the Fitbit HR stream instead
    averageSpeedMillimetersPerSecond: z.number().optional(),
    averagePaceSecondsPerMeter: z.number().optional(),
    caloriesKcal: z.number().optional(),
  })
  .passthrough();
export type MetricsSummary = z.infer<typeof metricsSummarySchema>;

export const exerciseMetadataSchema = z
  .object({ hasGps: z.boolean().optional() })
  .passthrough();

// The Exercise data-point value (DataPoint.data.exercise).
export const exerciseSchema = z
  .object({
    interval: sessionTimeIntervalSchema,
    exerciseType: z.string(), // bare enum, e.g. "RUNNING" (verified live)
    displayName: z.string().optional(),
    activeDuration: z.string().optional(), // Duration, excludes pauses ("1500s")
    notes: z.string().optional(),
    metricsSummary: metricsSummarySchema.optional(),
    exerciseMetadata: exerciseMetadataSchema.optional(),
  })
  .passthrough();
export type Exercise = z.infer<typeof exerciseSchema>;

// dataSource on a DataPoint — the upstream provenance. Verified live 2026-07-24:
// `platform` is FITBIT (the band's passive auto-detection) or HEALTH_CONNECT (a
// phone app / Samsung / Strava writing via Android Health Connect — matches the
// athlete's SOT to the metre). `recordingMethod` is ACTIVELY_MEASURED /
// PASSIVELY_MEASURED / MANUAL / UNKNOWN. Drives dedupe.
export const dataSourceSchema = z
  .object({
    platform: z.string().optional(),
    recordingMethod: z.string().optional(),
    device: z
      .object({ formFactor: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type GoogleHealthDataSource = z.infer<typeof dataSourceSchema>;

// A DataPoint of the `exercise` dataType. `name` is the resource path
// `users/{user}/dataTypes/exercise/dataPoints/{id}`; its trailing segment is the
// stable external id we key runs on.
export const exerciseDataPointSchema = z
  .object({
    name: z.string().optional(),
    dataSource: dataSourceSchema.optional(),
    exercise: exerciseSchema,
  })
  .passthrough();
export type ExerciseDataPoint = z.infer<typeof exerciseDataPointSchema>;

// GET .../dataPoints list envelope.
export const dataPointListSchema = z.object({
  dataPoints: z.array(exerciseDataPointSchema).optional().default([]),
  nextPageToken: z.string().optional(),
});
export type DataPointList = z.infer<typeof dataPointListSchema>;

// A `heart-rate` measurement dataPoint. Verified live 2026-07-24: instantaneous
// samples (Fitbit wrist, ~1 every 2–3 s during a run) with an int64-as-string bpm.
export const heartRateSampleSchema = z
  .object({
    dataSource: dataSourceSchema.optional(),
    heartRate: z
      .object({
        sampleTime: z.object({ physicalTime: z.string() }).passthrough(),
        beatsPerMinute: int64Number,
      })
      .passthrough(),
  })
  .passthrough();
export type HeartRateSample = z.infer<typeof heartRateSampleSchema>;

export const heartRateListSchema = z.object({
  dataPoints: z.array(heartRateSampleSchema).optional().default([]),
  nextPageToken: z.string().optional(),
});
export type HeartRateList = z.infer<typeof heartRateListSchema>;

// GET .../{dataPoint}:exportExerciseTcx response. Verified live 2026-07-24: the
// TCX document is returned JSON-wrapped in `tcxData` (application/json), NOT as a
// raw XML body. Absent when the run has no exportable track (e.g. a Fitbit Air
// run with no phone-recorded route).
export const exportTcxResponseSchema = z.object({
  tcxData: z.string().optional(),
});
export type ExportTcxResponse = z.infer<typeof exportTcxResponseSchema>;

// ── Wellness dataTypes (Workstream C: Fitbit Web API → Google Health) ─────────
// The four Fitbit passes — all-day activity (steps/distance/floors/active-minutes/
// calories), resting HR, sleep, HRV — migrate onto this same client before the
// Fitbit Web API sunsets Sept 2026. UNLIKE the live-verified exercise/heart-rate
// schemas above, these shapes follow the DOCUMENTED v4 model only. The exact
// union-field names, value units, and sleep-stage vocabulary are TODO(live) — to
// pin against real payloads exactly as Workstream A did for exercise. So a wrong
// guess can't hard-fail the whole pull, the list ENVELOPE is validated strictly
// here while each dataPoint's per-type value object stays a `.passthrough()` that
// the mapper (wellness.ts) reads defensively (missing field → null, never a throw).
//
// Google's DataPoint union nests the value under a camelCase field named for the
// dataType (verified: the `exercise` type → `dataPoint.exercise`). So a `steps`
// point is `{ name?, dataSource?, steps: { interval, count } }`, an `active-minutes`
// point is `{ …, activeMinutes: {…} }`, etc. (services/googleHealth/wellness.ts
// `unionField`). We keep the envelope generic and let the mapper reach in.
export const wellnessDataPointSchema = z
  .object({
    name: z.string().optional(),
    dataSource: dataSourceSchema.optional(),
  })
  .passthrough();
export type WellnessDataPoint = z.infer<typeof wellnessDataPointSchema>;

export const wellnessDataPointListSchema = z.object({
  dataPoints: z.array(wellnessDataPointSchema).optional().default([]),
  nextPageToken: z.string().optional(),
});
export type WellnessDataPointList = z.infer<typeof wellnessDataPointListSchema>;

// ── Daily rollup (steps / distance / floors / total-calories) ─────────────────
// POST .../dataTypes/{type}/dataPoints:dailyRollUp — the correct daily-TOTAL
// source for the four metrics List can't sum correctly (multi-source-overlapping
// samples; see wellnessMap.ts's ACTIVITY_METRICS comment for why). Pinned 2026-08-26
// against the REAL API (the docs-derived first pass — a flat {year,month,day,
// utcOffsetSeconds} — 400'd live: "Unknown name 'year' at range.start"). The doc
// text itself explains why: CivilDateTime deliberately has NO timezone/offset
// field ("ensures neither the timezone nor the UTC offset can be set, to avoid
// confusion between civil and physical time queries") — year/month/day nest
// under a `date` sub-object (mirrors google.type.Date), with an optional `time`
// sub-object we don't need (a bare date defaults to local midnight). Day
// buckets are interpreted in the ACCOUNT's own registered civil timezone, not
// one we pass — verified live against the athlete's Berlin account. The method
// being named `dailyRollUp` (capital U), not `dailyRollup`, was the earlier
// 404's root cause. The response nests each metric's total under a `*Sum` field
// on a union member named for the dataType. Live-verified 2026-08-26:
// steps→countSum (int64), distance→**millimetersSum** (int64 — NOT the
// documented `metersSum`; a probe against the real API showed the actual field),
// floors→floorsSum (double; the athlete's device reports no floors data, so this
// stays unverified against real values), totalCalories→kcalSum (double,
// confirmed live — 2.4k-4k kcal/day, plausible).
export const civilDateSchema = z.object({
  year: z.number().int(),
  month: z.number().int(),
  day: z.number().int(),
});
export const civilDateTimeSchema = z.object({
  date: civilDateSchema,
});
export type CivilDateTime = z.infer<typeof civilDateTimeSchema>;

export const rollupDataPointSchema = z
  .object({
    civilStartTime: civilDateTimeSchema.optional(),
    civilEndTime: civilDateTimeSchema.optional(),
    steps: z
      .object({ countSum: int64Number.optional() })
      .passthrough()
      .optional(),
    distance: z
      .object({ millimetersSum: int64Number.optional() })
      .passthrough()
      .optional(),
    floors: z
      .object({ floorsSum: z.number().optional() })
      .passthrough()
      .optional(),
    totalCalories: z
      .object({ kcalSum: z.number().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type RollupDataPoint = z.infer<typeof rollupDataPointSchema>;

export const dailyRollUpResponseSchema = z.object({
  rollupDataPoints: z.array(rollupDataPointSchema).optional().default([]),
  nextPageToken: z.string().optional(),
});
export type DailyRollUpResponse = z.infer<typeof dailyRollUpResponseSchema>;
