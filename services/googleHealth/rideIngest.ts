import { logger } from '../logger';
import { findOverlappingActivities } from '../activitySources';
import { upsertGear, linkRideGear } from '../gear';
import { hrmForRun } from '../../lib/gear';
import { hasRideStreams, upsertRideStreams } from '../runStreams';
import { updateRideStartGps, updateRideHr } from '../rides';
import { upsertRide } from '../strava/rideIngest';
import { getValidAccessToken } from './oauth';
import { listExerciseSessionsPage, GoogleHealthRateLimitError } from './client';
import { fetchGoogleHealthRunStreams } from './streams';
import { fetchGoogleHealthHeartRateStream } from './heartRate';
import { isIngestableCyclingExercise, mapExerciseToRide } from './mapper';
import { dedupeRuns, sessionInterval } from './dedupe';
import type { ExerciseDataPoint } from './types';

// Google Health ride ingestion: page through the user's exercise sessions,
// keep the bike rides, and upsert them into public.rides (source
// 'google_health') keyed on (source, external_id). Mirrors
// services/googleHealth/ingest.ts (the run ingest) exactly — same dedupe,
// same TCX/HR stream reuse (parseTcxTrackpoints/buildHeartRateStream have no
// activity-type coupling, so fetchGoogleHealthRunStreams/
// fetchGoogleHealthHeartRateStream are reused verbatim rather than
// duplicated). Google Health is the PRIMARY live source for rides, same as
// for runs — Strava plays a secondary backfill/enrichment role.

const DEFAULT_PAGE_SIZE = 100;

export interface GoogleHealthRideBackfillOptions {
  pageSize?: number;
  startTimeAfter?: string;
  withStreams?: boolean;
  pageDelayMs?: number;
  maxPages?: number;
}

export interface GoogleHealthRideBackfillSummary {
  pagesFetched: number;
  sessionsSeen: number;
  ridesInserted: number;
  ridesUpdated: number;
  skippedNonRide: number;
  ridesDeduped: number;
  ridesSkippedExisting: number;
  streamsFetched: number;
  hrStreamsFetched: number;
  rateLimited: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function backfillGoogleHealthRides(
  opts: GoogleHealthRideBackfillOptions = {},
): Promise<GoogleHealthRideBackfillSummary> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const withStreams = opts.withStreams ?? true;
  const pageDelayMs = opts.pageDelayMs ?? 250;
  const maxPages = opts.maxPages ?? 100;

  const accessToken = await getValidAccessToken();

  const summary: GoogleHealthRideBackfillSummary = {
    pagesFetched: 0,
    sessionsSeen: 0,
    ridesInserted: 0,
    ridesUpdated: 0,
    skippedNonRide: 0,
    ridesDeduped: 0,
    ridesSkippedExisting: 0,
    streamsFetched: 0,
    hrStreamsFetched: 0,
    rateLimited: false,
  };

  const watermarkMs =
    opts.startTimeAfter != null ? Date.parse(opts.startTimeAfter) : null;

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
        if (watermarkMs != null) {
          const iv = sessionInterval(dp);
          if (iv && iv.startMs <= watermarkMs) continue;
        }
        if (isIngestableCyclingExercise(dp)) candidates.push(dp);
        else summary.skippedNonRide++;
      }
      pageToken = list.nextPageToken;
      if (!pageToken) break;
      await sleep(pageDelayMs);
    }
  } catch (err) {
    if (err instanceof GoogleHealthRateLimitError) summary.rateLimited = true;
    else throw err;
  }

  const { canonical, dropped } = dedupeRuns(candidates);
  summary.ridesDeduped = dropped;

  try {
    for (const dp of canonical) {
      const ride = mapExerciseToRide(dp);

      const iv = sessionInterval(dp);
      // Google Health is the lowest-priority source (MZY-225,
      // lib/activitySourcePriority.ts): any stored twin of any source wins.
      if (
        iv &&
        (
          await findOverlappingActivities('ride', iv.startMs, iv.endMs, {
            source: ride.source,
            externalId: ride.external_id,
          })
        ).length > 0
      ) {
        summary.ridesSkippedExisting++;
        continue;
      }

      const result = await upsertRide(ride);
      if (result.status === 'inserted') summary.ridesInserted++;
      else summary.ridesUpdated++;

      const hrm = hrmForRun(ride.avg_hr, ride.date);
      if (hrm) {
        await upsertGear({
          gear_id: hrm.gear_id,
          name: hrm.name,
          brand: hrm.brand,
          source: 'local',
          category: 'hrm',
        });
        await linkRideGear(result.id, hrm.gear_id);
      }

      if (
        withStreams &&
        dp.name != null &&
        !(await hasRideStreams(result.id, 'google_health'))
      ) {
        const parsed = await fetchGoogleHealthRunStreams(accessToken, dp.name);
        if (parsed.streams) {
          await upsertRideStreams(result.id, 'google_health', parsed.streams);
          summary.streamsFetched++;
        }
        await updateRideStartGps(result.id, parsed.startLat, parsed.startLng);
      }

      if (withStreams && iv && !(await hasRideStreams(result.id, 'fitbit'))) {
        const hr = await fetchGoogleHealthHeartRateStream(
          accessToken,
          iv.startMs,
          iv.endMs,
        );
        if (hr) {
          await upsertRideStreams(result.id, 'fitbit', hr.stream);
          await updateRideHr(
            result.id,
            ride.avg_hr == null ? hr.avgHr : null,
            ride.max_hr == null ? hr.maxHr : null,
          );
          summary.hrStreamsFetched++;
        }
      }
    }
  } catch (err) {
    if (err instanceof GoogleHealthRateLimitError) {
      summary.rateLimited = true;
      logger.warn(
        'google-health ride backfill stopped on rate limit — resume later',
        {
          job: 'google-health-ride-backfill',
          ...summary,
        },
      );
      return summary;
    }
    throw err;
  }

  logger.info('google-health ride backfill complete', {
    job: 'google-health-ride-backfill',
    ...summary,
  });
  return summary;
}
