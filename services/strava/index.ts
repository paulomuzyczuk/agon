// Public surface of the Strava ingestion module.
export * from './types';
export {
  exchangeAuthorizationCode,
  getValidAccessToken,
  getStoredTokens,
  accessTokenIsFresh,
  type StoredTokens,
} from './oauth';
export {
  listActivitiesPage,
  getGearName,
  StravaRateLimitError,
} from './client';
export { isRunActivity, isIngestableRun, mapActivityToRun } from './mapper';
export {
  backfillHistoricalRuns,
  upsertRun,
  type BackfillOptions,
  type BackfillSummary,
} from './ingest';
export {
  syncNewStravaRuns,
  getStravaWatermark,
  afterEpochFromWatermark,
  describeSyncSummary,
  type StravaSyncSummary,
  type SyncOptions,
  type SyncDeps,
} from './sync';
