// Public surface of the Google Health ingestion module (Run Ingestion Pivot).
export * from './types';
export {
  exchangeAuthorizationCode,
  getValidAccessToken,
  getStoredTokens,
  accessTokenIsFresh,
  type GoogleHealthStoredTokens,
} from './oauth';
export {
  listExerciseSessionsPage,
  exportExerciseTcx,
  listHeartRateSamplesPage,
  listDataPointsPage,
  GoogleHealthRateLimitError,
  type ListExerciseParams,
  type HeartRateWindowParams,
  type ListDataPointsParams,
} from './client';
export {
  buildHeartRateStream,
  fetchGoogleHealthHeartRateStream,
  type HeartRateStream,
} from './heartRate';
export {
  isRunExerciseType,
  isIngestableExercise,
  mapExerciseToRun,
  parseDurationSeconds,
  dataPointExternalId,
  dataPointOrigin,
  localStartDate,
  type GoogleHealthMapOptions,
} from './mapper';
export {
  parseTcxTrackpoints,
  fetchGoogleHealthRunStreams,
  type GoogleHealthStreams,
} from './streams';
export {
  dedupeRuns,
  sessionInterval,
  type DedupeResult,
  type RunInterval,
} from './dedupe';
export {
  backfillGoogleHealthRuns,
  type GoogleHealthBackfillOptions,
  type GoogleHealthBackfillSummary,
} from './ingest';
export {
  syncNewGoogleHealthRuns,
  getGoogleHealthWatermark,
  startTimeAfterFromWatermark,
  describeGoogleHealthSyncSummary,
  type GoogleHealthSyncSummary,
  type GoogleHealthSyncOptions,
  type GoogleHealthSyncDeps,
} from './sync';
export {
  backfillGoogleHealthWellness,
  unionField,
  valueObject,
  wellnessExternalId,
  readNumber,
  readValueStart,
  structuredDateToISO,
  foldActivityPoints,
  accumulatorToRecords,
  mapSleepSession,
  mapDailyHrv,
  sessionRangeFilter,
  intervalRangeFilter,
  dailyRangeFilter,
  rangeFilterFor,
  ACTIVITY_METRICS,
  type GoogleHealthWellnessOptions,
  type GoogleHealthWellnessSummary,
  type GoogleHealthWellnessDeps,
  type ActivityAccumulator,
} from './wellness';
