import { query } from '../db';
import { logger } from '../logger';
import { DATA_SOURCES } from '../../lib/constants';
import {
  backfillGoogleHealthRuns,
  type GoogleHealthBackfillOptions,
  type GoogleHealthBackfillSummary,
} from './ingest';

// Incremental Google Health sync — the forward run path after the Strava pivot.
// Pulls only the runs that landed since the newest google_health run we already
// hold, rather than re-paging the whole history. Reuses the Strava watermark
// design verbatim (services/strava/sync.ts): the single source of truth for
// "newest run we have" is the DB (max(runs.started_at) WHERE source), not a
// separate cursor table, so it can't drift from the data.
//
// The API's start_time filter (client.listExerciseSessionsPage) wants an RFC-3339
// instant, so the watermark Date is emitted as an ISO string. The pull stays
// idempotent (upsertRun on (source, external_id)) and rate-limit-aware
// (backfillGoogleHealthRuns stops cleanly on HTTP 429), so an interrupted sync
// just resumes from the advanced watermark next run.

export interface GoogleHealthSyncSummary extends GoogleHealthBackfillSummary {
  /**
   * RFC-3339 instant used as the `start_time >` filter (the watermark). `null`
   * means no prior google_health run existed, so this sync pulled the full
   * history — i.e. the first sync on an empty DB behaves like a backfill.
   */
  since: string | null;
}

export interface GoogleHealthSyncOptions {
  /** Also pull each new run's TCX (HR/route series + GPS). Default true. */
  withStreams?: boolean;
  maxPages?: number;
  pageDelayMs?: number;
  pageSize?: number;
}

/** Seams so the orchestration is unit-testable with no DB and no network. */
export interface GoogleHealthSyncDeps {
  getWatermark: () => Promise<Date | null>;
  runIncremental: (
    opts: GoogleHealthBackfillOptions,
  ) => Promise<GoogleHealthBackfillSummary>;
}

/**
 * The sync watermark: the latest start time we already hold for a google_health
 * run, or null if we hold none. node-postgres maps a timestamp column to a Date.
 */
export async function getGoogleHealthWatermark(): Promise<Date | null> {
  const { rows } = await query<{ latest: Date | null }>(
    `SELECT max(started_at) AS latest FROM public.runs WHERE source = $1`,
    [DATA_SOURCES.GOOGLE_HEALTH],
  );
  return rows[0]?.latest ?? null;
}

/**
 * Convert a watermark to the RFC-3339 `start_time >` filter (an exclusive lower
 * bound, so the boundary run we already hold isn't re-fetched). Null watermark →
 * undefined → full pull.
 */
export function startTimeAfterFromWatermark(
  watermark: Date | null,
): string | undefined {
  return watermark == null ? undefined : watermark.toISOString();
}

const defaultDeps: GoogleHealthSyncDeps = {
  getWatermark: getGoogleHealthWatermark,
  runIncremental: backfillGoogleHealthRuns,
};

/**
 * Pull new Google Health runs since the DB watermark. Returns the backfill
 * summary plus the `since` instant it filtered on. Never throws on a rate limit —
 * the summary's `rateLimited` flag reports it, and the next sync resumes.
 */
export async function syncNewGoogleHealthRuns(
  opts: GoogleHealthSyncOptions = {},
  deps: GoogleHealthSyncDeps = defaultDeps,
): Promise<GoogleHealthSyncSummary> {
  const watermark = await deps.getWatermark();
  const startTimeAfter = startTimeAfterFromWatermark(watermark);

  logger.info('starting google-health incremental sync', {
    job: 'google-health-sync',
    since: startTimeAfter ?? null,
  });

  const summary = await deps.runIncremental({
    startTimeAfter,
    withStreams: opts.withStreams ?? true,
    maxPages: opts.maxPages,
    pageDelayMs: opts.pageDelayMs,
    pageSize: opts.pageSize,
  });

  const result: GoogleHealthSyncSummary = {
    ...summary,
    since: startTimeAfter ?? null,
  };
  logger.info('google-health incremental sync complete', {
    job: 'google-health-sync',
    ...result,
  });
  return result;
}

/** One-line human summary of a sync, shared by the CLI script and Telegram bot. */
export function describeGoogleHealthSyncSummary(
  s: GoogleHealthSyncSummary,
): string {
  const n = s.runsInserted;
  const noun = n === 1 ? 'run' : 'runs';
  if (s.rateLimited) {
    return `Pulled ${n} new ${noun} before hitting Google Health's rate limit — sync again shortly to resume.`;
  }
  return `Pulled ${n} new ${noun}.`;
}
