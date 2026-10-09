// ⚠️ DEPRECATED 2026-07-24 (Run Ingestion Pivot, Workstream C — CLAUDE.md). The
// legacy Fitbit Web API this module speaks sunsets September 2026 (Google OAuth
// migration; tokens do NOT transfer — users re-consent). Its four passes migrated
// onto the Google Health API client: run HR is folded into the run adapter
// (services/googleHealth/heartRate.ts), and all-day activity / resting HR / sleep
// / HRV into services/googleHealth/wellness.ts (`pnpm gh:wellness`). This module
// is kept — harmless and still correct against the live-until-Sept-2026 API — as a
// fallback during cutover, but it is no longer the forward path. Retire it (and
// the fitbit_oauth_tokens table) after the Google Health wellness pull is verified
// live. See docs/run-ingestion-migration.md §6.

// Public surface of the Fitbit ingestion module.
export * from './types';
export {
  exchangeAuthorizationCode,
  getValidAccessToken,
  getStoredTokens,
  accessTokenIsFresh,
  type FitbitStoredTokens,
} from './oauth';
export {
  getIntradayHeartRate,
  getDailyActivitySummary,
  getSleepLogs,
  getHrv,
  FitbitRateLimitError,
} from './client';
export {
  intradayToRunStream,
  summaryToDailyActivity,
  sleepLogToRecord,
  hrvToRecord,
} from './mapper';
export {
  backfillFitbit,
  type FitbitBackfillOptions,
  type FitbitBackfillSummary,
} from './ingest';
