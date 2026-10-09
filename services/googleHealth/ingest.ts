import { logger } from '../logger';
import { findOverlappingActivities } from '../activitySources';
import { upsertGear, linkRunGear } from '../gear';
import { hrmForRun } from '../../lib/gear';
import { hasRunStreams, upsertRunStreams } from '../runStreams';
import { updateRunStartGps, updateRunHr } from '../runs';
import { upsertRun } from '../strava/ingest';
import { getValidAccessToken } from './oauth';
import { listExerciseSessionsPage, GoogleHealthRateLimitError } from './client';
import { fetchGoogleHealthRunStreams } from './streams';
import { fetchGoogleHealthHeartRateStream } from './heartRate';
import { isIngestableExercise, mapExerciseToRun } from './mapper';
import { dedupeRuns, sessionInterval } from './dedupe';
import type { ExerciseDataPoint } from './types';

// Google Health run ingestion: page through the user's exercise sessions, keep
// the runs, and upsert them into public.runs (source 'google_health') keyed on
// (source, external_id). Mirrors services/strava/ingest.ts; the shared idempotent
// upsertRun lives there. Route/HR series come from the per-session TCX export
// (services/googleHealth/streams.ts) and also seed the run's GPS start.

const DEFAULT_PAGE_SIZE = 100;

export interface GoogleHealthBackfillOptions {
  pageSize?: number;
  /** RFC-3339 lower bound — only sessions after this instant (incremental sync). */
  startTimeAfter?: string;
  /**
   * Also pull each run's TCX (route + HR time series) into run_streams and seed
   * its GPS start. On by default: the export is one call per run and runs are few.
   * Resumable — runs that already have a stream are skipped.
   */
  withStreams?: boolean;
  pageDelayMs?: number;
  /** safety cap so a bug can't loop forever against the API. */
  maxPages?: number;
}

export interface GoogleHealthBackfillSummary {
  pagesFetched: number;
  sessionsSeen: number;
  runsInserted: number;
  runsUpdated: number;
  skippedNonRun: number;
  /** overlapping duplicate records collapsed away by the dedupe pass. */
  runsDeduped: number;
  /** canonical runs skipped because a different overlapping run already exists. */
  runsSkippedExisting: number;
  /** run_streams rows fetched this pass (0 unless withStreams). */
  streamsFetched: number;
  /** Fitbit-wrist HR series attached this pass (source='fitbit'). */
  hrStreamsFetched: number;
  /** true if the run stopped early because the API returned HTTP 429. */
  rateLimited: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function backfillGoogleHealthRuns(
  opts: GoogleHealthBackfillOptions = {},
): Promise<GoogleHealthBackfillSummary> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const withStreams = opts.withStreams ?? true;
  const pageDelayMs = opts.pageDelayMs ?? 250;
  const maxPages = opts.maxPages ?? 100;

  const accessToken = await getValidAccessToken();

  const summary: GoogleHealthBackfillSummary = {
    pagesFetched: 0,
    sessionsSeen: 0,
    runsInserted: 0,
    runsUpdated: 0,
    skippedNonRun: 0,
    runsDeduped: 0,
    runsSkippedExisting: 0,
    streamsFetched: 0,
    hrStreamsFetched: 0,
    rateLimited: false,
  };

  // The incremental watermark is applied CLIENT-SIDE: the exercise dataType
  // exposes no server-side start-time filter that parses (verified live
  // 2026-08-01 — see client.ts). Sessions strictly after this instant are new;
  // everything at/before it is already stored. Null → full pull (first sync).
  const watermarkMs =
    opts.startTimeAfter != null ? Date.parse(opts.startTimeAfter) : null;

  // Phase 1 — page through and COLLECT the ingestable runs. Dedupe needs the
  // whole batch at once (a run's two records can sit on different pages), so we
  // gather first and write second. A 429 here stops paging but still lets us
  // dedupe + persist what we already have.
  const candidates: ExerciseDataPoint[] = [];
  try {
    let pageToken: string | undefined;
    for (let page = 1; page <= maxPages; page++) {
      const list = await listExerciseSessionsPage(accessToken, {
        pageSize,
        pageToken,
      });
      summary.pagesFetched++;
      for (const dp of list.dataPoints) {
        summary.sessionsSeen++;
        // Client-side watermark: skip sessions at/before the last-synced instant.
        if (watermarkMs != null) {
          const iv = sessionInterval(dp);
          if (iv && iv.startMs <= watermarkMs) continue;
        }
        if (isIngestableExercise(dp)) candidates.push(dp);
        else summary.skippedNonRun++;
      }
      pageToken = list.nextPageToken;
      if (!pageToken) break; // no more pages
      await sleep(pageDelayMs);
    }
  } catch (err) {
    if (err instanceof GoogleHealthRateLimitError) summary.rateLimited = true;
    else throw err;
  }

  // Collapse overlapping duplicates (Fitbit auto-detect twin of a Health Connect
  // record) to one canonical run, preferring the SOT-accurate record.
  const { canonical, dropped } = dedupeRuns(candidates);
  summary.runsDeduped = dropped;

  // Phase 2 — persist the canonical runs.
  try {
    for (const dp of canonical) {
      const run = mapExerciseToRun(dp);

      // Cross-sync guard. Google Health is the lowest-priority source (MZY-225,
      // lib/activitySourcePriority.ts), so ANY stored twin wins: its own
      // Fitbit/Health Connect twin from an earlier sync, a Strava or export copy,
      // or an Agon recording of the same run. Keep what's stored and skip.
      const iv = sessionInterval(dp);
      if (
        iv &&
        (
          await findOverlappingActivities('run', iv.startMs, iv.endMs, {
            source: run.source,
            externalId: run.external_id,
          })
        ).length > 0
      ) {
        summary.runsSkippedExisting++;
        continue;
      }

      const result = await upsertRun(run);
      if (result.status === 'inserted') summary.runsInserted++;
      else summary.runsUpdated++;

      // HRM worn on this run's date (Garmin HRM 200 from Jul 2026), linked ONLY
      // when the run actually has HR — no HR ⇒ assume no strap. Same rule as the
      // Strava ingest.
      const hrm = hrmForRun(run.avg_hr, run.date);
      if (hrm) {
        await upsertGear({
          gear_id: hrm.gear_id,
          name: hrm.name,
          brand: hrm.brand,
          source: 'local',
          category: 'hrm',
        });
        await linkRunGear(result.id, hrm.gear_id);
      }

      // Heavy per-run pass: pull the TCX for the HR/route series and the GPS
      // start. `exerciseMetadata.hasGps` proved unreliable (absent even on real
      // runs — verified 2026-07-24), so we always attempt the export when streams
      // are on and let it no-op for route-less runs. Skip runs already streamed so
      // a re-run resumes cheaply. NOTE: route-less runs persist no stream, so a
      // *full* re-backfill re-fetches their (empty) TCX; the incremental sync only
      // touches new runs, so steady-state cost is tiny.
      if (
        withStreams &&
        dp.name != null &&
        !(await hasRunStreams(result.id, 'google_health'))
      ) {
        const parsed = await fetchGoogleHealthRunStreams(accessToken, dp.name);
        if (parsed.streams) {
          await upsertRunStreams(result.id, 'google_health', parsed.streams);
          summary.streamsFetched++;
        }
        await updateRunStartGps(result.id, parsed.startLat, parsed.startLng);
      }

      // Fitbit wrist HR: pull the granular heart-rate samples for the run's window
      // into run_streams (source 'fitbit', kept distinct from the SOT-sourced run
      // metrics), and FILL avg/max HR only where the run had none. Skip runs that
      // already carry a fitbit series so a re-run resumes cheaply.
      if (withStreams && iv && !(await hasRunStreams(result.id, 'fitbit'))) {
        const hr = await fetchGoogleHealthHeartRateStream(
          accessToken,
          iv.startMs,
          iv.endMs,
        );
        if (hr) {
          await upsertRunStreams(result.id, 'fitbit', hr.stream);
          await updateRunHr(
            result.id,
            run.avg_hr == null ? hr.avgHr : null,
            run.max_hr == null ? hr.maxHr : null,
          );
          summary.hrStreamsFetched++;
        }
      }
    }
  } catch (err) {
    if (err instanceof GoogleHealthRateLimitError) {
      summary.rateLimited = true;
      logger.warn(
        'google-health backfill stopped on rate limit — resume later',
        {
          job: 'google-health-backfill',
          ...summary,
        },
      );
      return summary;
    }
    throw err;
  }

  logger.info('google-health backfill complete', {
    job: 'google-health-backfill',
    ...summary,
  });
  return summary;
}
