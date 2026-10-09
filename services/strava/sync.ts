import { query } from '../db';
import { logger } from '../logger';
import { DATA_SOURCES } from '../../lib/constants';
import {
  backfillHistoricalRuns,
  type BackfillOptions,
  type BackfillSummary,
} from './ingest';

// ⚠️ DEPRECATED 2026-07-24 (Run Ingestion Pivot in CLAUDE.md). Strava's API now
// requires a paid Strava subscription for Standard-tier access (since
// 2026-06-30), which defeats Agon's cost-free goal, so Strava is retired as the
// live run source. This module is kept — harmless, still correct, and its
// DB-derived-watermark design is the template the Google Health adapter reuses —
// but it is no longer the forward path. New live runs come from the Google Health
// API (Fitbit Air + phone connected-GPS); see docs/run-ingestion-migration.md.
// The historical Strava BACKFILL data already in Postgres remains valid.
//
// Incremental Strava sync: pull only the runs that landed since the last one we
// stored, rather than re-paging the whole history. It reuses the backfill
// orchestrator wholesale — the only new idea here is the *watermark*: the most
// recent runs.started_at we already hold for source='strava' becomes Strava's
// `after` filter, so a normal sync fetches a page or two, not decades.
//
// The pull stays idempotent (upsertRun is keyed on strava_activity_id) and
// rate-limit-aware (backfillHistoricalRuns stops cleanly on HTTP 429), so a sync
// interrupted mid-way just resumes on the next run. New runs also get their HR
// streams by default — there are few of them, so the extra per-run call is cheap.

export interface StravaSyncSummary extends BackfillSummary {
  /**
   * Epoch seconds used as Strava's `after` filter (the watermark). `null` means
   * no prior Strava run existed, so this sync pulled the full history — i.e. the
   * first sync on an empty DB behaves like a backfill.
   */
  since: number | null;
}

export interface SyncOptions {
  /** Also pull each new run's full time series into run_streams. Default true. */
  withStreams?: boolean;
  /** Resolve Strava shoe names into the gear catalog. Default true. */
  resolveGear?: boolean;
  maxPages?: number;
  pageDelayMs?: number;
}

/** Seams so the orchestration is unit-testable with no DB and no network. */
export interface SyncDeps {
  getWatermark: () => Promise<Date | null>;
  runIncremental: (opts: BackfillOptions) => Promise<BackfillSummary>;
}

/**
 * The sync watermark: the latest start time we already hold for a Strava run, or
 * null if we hold none. node-postgres maps a timestamp column to a JS Date.
 */
export async function getStravaWatermark(): Promise<Date | null> {
  const { rows } = await query<{ latest: Date | null }>(
    `SELECT max(started_at) AS latest FROM public.runs WHERE source = $1`,
    [DATA_SOURCES.STRAVA],
  );
  return rows[0]?.latest ?? null;
}

/**
 * Convert a watermark to Strava's `after` epoch (seconds). Strava's `after` is
 * exclusive, which is exactly what we want: the run at the watermark instant is
 * the one we already have, so excluding it avoids a redundant fetch while still
 * catching everything strictly newer. Null watermark → undefined → full pull.
 */
export function afterEpochFromWatermark(
  watermark: Date | null,
): number | undefined {
  if (watermark == null) return undefined;
  return Math.floor(watermark.getTime() / 1000);
}

const defaultDeps: SyncDeps = {
  getWatermark: getStravaWatermark,
  runIncremental: backfillHistoricalRuns,
};

/**
 * Pull new Strava runs since the DB watermark. Returns the backfill summary plus
 * the `since` epoch it filtered on. Never throws on a rate limit — the summary's
 * `rateLimited` flag reports it, and the next sync resumes from the new watermark.
 */
export async function syncNewStravaRuns(
  opts: SyncOptions = {},
  deps: SyncDeps = defaultDeps,
): Promise<StravaSyncSummary> {
  const watermark = await deps.getWatermark();
  const after = afterEpochFromWatermark(watermark);

  logger.info('starting strava incremental sync', {
    job: 'strava-sync',
    since: after ?? null,
  });

  const summary = await deps.runIncremental({
    after,
    withStreams: opts.withStreams ?? true,
    resolveGear: opts.resolveGear ?? true,
    maxPages: opts.maxPages,
    pageDelayMs: opts.pageDelayMs,
  });

  const result: StravaSyncSummary = { ...summary, since: after ?? null };
  logger.info('strava incremental sync complete', {
    job: 'strava-sync',
    ...result,
  });
  return result;
}

/** One-line human summary of a sync, shared by the CLI script and the Telegram bot. */
export function describeSyncSummary(s: StravaSyncSummary): string {
  const n = s.runsInserted;
  const noun = n === 1 ? 'run' : 'runs';
  if (s.rateLimited) {
    return `Pulled ${n} new ${noun} before hitting Strava's rate limit — sync again shortly to resume.`;
  }
  return `Pulled ${n} new ${noun}.`;
}
