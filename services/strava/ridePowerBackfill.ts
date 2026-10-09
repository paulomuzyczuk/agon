import { logger } from '../logger';
import { recomputeDerivedForActivity } from '../activityDerived';
import {
  listStravaRidesForPower,
  updateRidePower,
  updateRideStreamWatts,
  type StoredRidePower,
} from '../ridePower';
import {
  diffRidePower,
  isPowerCorrected,
  type RidePowerChange,
} from '../../lib/ridePower';
import { getValidAccessToken } from './oauth';
import { listActivitiesPage, StravaRateLimitError } from './client';
import { fetchStravaRunStreams, withStravaWattsSource } from './streams';
import { powerFields } from './mapper';

// Re-pull power for rides already stored from Strava (MZY-267). Rides
// ingested before the power columns existed have none; their summary watts
// come back from the cheap paged /athlete/activities list (200 per call), so
// the backfill costs one list page per 200 activities. The heavier
// per-activity streams call is made only where it can pay off: rides whose
// summary says a power meter measured them (`device_watts`), or every
// matched ride with `probeStreams` (to check whether Strava serves its
// estimated watts as a stream at all).
//
// Dry run by default: computes and reports every change, writes nothing.
// Writes are targeted (services/ridePower.ts) — power columns and the watts
// series only, hand corrections respected. Rate limits stop the run cleanly;
// it is idempotent, so a re-run resumes.

const STRAVA_MAX_PER_PAGE = 200;
const DAY_S = 86_400;

export interface RidePowerBackfillOptions {
  write: boolean;
  /** Also fetch streams for rides Strava says have NO meter (one call each). */
  probeStreams?: boolean;
  pageDelayMs?: number;
  maxPages?: number;
}

export interface RidePowerChangeReport {
  rideId: string;
  date: string;
  externalId: string;
  changes: RidePowerChange[];
}

export interface StreamProbeReport {
  rideId: string;
  date: string;
  deviceWatts: boolean;
  /** Whether Strava returned a watts series for this ride. */
  hasWatts: boolean;
  /** What happened to it (write mode only). */
  stored?: 'updated' | 'inserted' | 'length_mismatch';
}

export interface RidePowerBackfillSummary {
  write: boolean;
  pagesFetched: number;
  ridesStored: number;
  ridesMatched: number;
  ridesChanged: number;
  ridesSkippedCorrected: number;
  changes: RidePowerChangeReport[];
  streams: StreamProbeReport[];
  derivedRecomputed: number;
  rateLimited: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Strava `after` epoch: a day before the earliest stored ride, or undefined. */
export function listAfterEpoch(rides: StoredRidePower[]): number | undefined {
  const starts = rides
    .map((r) => (r.startedAt ? Date.parse(r.startedAt) : Date.parse(r.date)))
    .filter((ms) => Number.isFinite(ms));
  if (starts.length === 0) return undefined;
  return Math.floor(Math.min(...starts) / 1000) - DAY_S;
}

export async function backfillRidePower(
  opts: RidePowerBackfillOptions,
): Promise<RidePowerBackfillSummary> {
  const pageDelayMs = opts.pageDelayMs ?? 250;
  const maxPages = opts.maxPages ?? 50;

  const stored = await listStravaRidesForPower();
  const byExternalId = new Map(stored.map((r) => [r.externalId, r]));
  const summary: RidePowerBackfillSummary = {
    write: opts.write,
    pagesFetched: 0,
    ridesStored: stored.length,
    ridesMatched: 0,
    ridesChanged: 0,
    ridesSkippedCorrected: 0,
    changes: [],
    streams: [],
    derivedRecomputed: 0,
    rateLimited: false,
  };
  if (stored.length === 0) return summary;

  const accessToken = await getValidAccessToken();
  const after = listAfterEpoch(stored);
  const touched = new Set<string>();

  try {
    for (let page = 1; page <= maxPages; page++) {
      const activities = await listActivitiesPage(accessToken, {
        page,
        perPage: STRAVA_MAX_PER_PAGE,
        after,
      });
      summary.pagesFetched++;
      if (activities.length === 0) break;

      for (const activity of activities) {
        const ride = byExternalId.get(String(activity.id));
        if (!ride) continue;
        summary.ridesMatched++;

        const incoming = powerFields(activity);
        if (isPowerCorrected(ride.correctedFields)) {
          summary.ridesSkippedCorrected++;
        } else {
          const changes = diffRidePower(ride, incoming);
          if (changes.length > 0) {
            summary.ridesChanged++;
            summary.changes.push({
              rideId: ride.id,
              date: ride.date,
              externalId: ride.externalId,
              changes,
            });
            if (opts.write && (await updateRidePower(ride.id, incoming))) {
              touched.add(ride.id);
            }
          }
        }

        const deviceWatts = activity.device_watts === true;
        if (deviceWatts || opts.probeStreams) {
          const streams = await fetchStravaRunStreams(accessToken, activity.id);
          const report: StreamProbeReport = {
            rideId: ride.id,
            date: ride.date,
            deviceWatts,
            hasWatts: Boolean(streams?.watts),
          };
          if (opts.write && streams?.watts) {
            report.stored = await updateRideStreamWatts(
              ride.id,
              'strava',
              withStravaWattsSource(streams, activity.device_watts),
            );
            if (report.stored !== 'length_mismatch') touched.add(ride.id);
          }
          summary.streams.push(report);
        }
      }

      if (activities.length < STRAVA_MAX_PER_PAGE) break;
      await sleep(pageDelayMs);
    }
  } catch (err) {
    if (!(err instanceof StravaRateLimitError)) throw err;
    summary.rateLimited = true;
    logger.warn(
      'ride power backfill stopped on rate limit — re-run to resume',
      {
        job: 'ride-power-backfill',
        pagesFetched: summary.pagesFetched,
        ridesMatched: summary.ridesMatched,
      },
    );
  }

  // Refresh what is derived from each written ride. Nothing reads power yet
  // (derived power metrics are MZY-267 phase 3, which adds its own step to
  // recomputeDerivedForActivity), so today this only re-runs the ride's
  // existing steps — harmless, and it means the hook is already in place.
  for (const id of touched) {
    const ride = stored.find((r) => r.id === id)!;
    await recomputeDerivedForActivity('ride', id, {
      startMoved: false,
      fromDate: ride.date,
    });
    summary.derivedRecomputed++;
  }

  logger.info('ride power backfill complete', {
    job: 'ride-power-backfill',
    write: summary.write,
    ridesStored: summary.ridesStored,
    ridesMatched: summary.ridesMatched,
    ridesChanged: summary.ridesChanged,
    ridesSkippedCorrected: summary.ridesSkippedCorrected,
    streamsFetched: summary.streams.length,
    derivedRecomputed: summary.derivedRecomputed,
    rateLimited: summary.rateLimited,
  });
  return summary;
}
