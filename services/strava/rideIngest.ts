import { query } from '../db';
import { logger } from '../logger';
import { upsertGear, linkRideGear } from '../gear';
import { hrmForRun } from '../../lib/gear';
import { hasRideStreams, upsertRideStreams } from '../runStreams';
import type { RideRecord } from '../../lib/types';
import { upsertSetKeepingCorrections } from '../activityCorrections';
import { getValidAccessToken } from './oauth';
import {
  getGearName,
  listActivitiesPage,
  StravaRateLimitError,
} from './client';
import { fetchStravaRunStreams, withStravaWattsSource } from './streams';
import { isIngestableRide, mapActivityToRide } from './mapper';
import {
  classifyIncomingActivity,
  supersedeActivities,
} from '../activitySources';

// Historical backfill: page through the athlete's Strava activities, keep the
// rides, and upsert them into public.rides keyed on (source, external_id).
// Mirrors services/strava/ingest.ts (the run backfill) — see that file for the
// fuller rationale on rate-limit handling and resumability. Strava plays the
// same secondary (historical backfill / enrichment) role for rides that it now
// plays for runs — Google Health is the live source (see rideIngest.ts's
// sibling services/googleHealth/rideIngest.ts).

const STRAVA_MAX_PER_PAGE = 200;

export interface RideBackfillOptions {
  perPage?: number;
  after?: number;
  before?: number;
  resolveGear?: boolean;
  withStreams?: boolean;
  pageDelayMs?: number;
  maxPages?: number;
}

export interface RideBackfillSummary {
  pagesFetched: number;
  activitiesSeen: number;
  ridesInserted: number;
  ridesUpdated: number;
  skippedNonRide: number;
  /** Rides skipped for an equal-or-higher-priority twin (MZY-225). */
  ridesSkippedExisting: number;
  /** Lower-priority twins (Google Health) replaced by the Strava ride. */
  ridesSuperseded: number;
  streamsFetched: number;
  rateLimited: boolean;
}

export interface UpsertRideResult {
  id: string;
  status: 'inserted' | 'updated';
}

/**
 * Idempotent upsert, keyed on `(source, external_id)` — same design as
 * services/strava/ingest.ts upsertRun. Deliberately leaves the qualitative
 * fields (perceived_effort, general_notes) and weather enrichment untouched
 * on conflict, so a re-run never clobbers them. Hand-corrected columns
 * (rides.corrected_fields, see services/activityCorrections.ts) keep their
 * stored value too.
 */
export async function upsertRide(r: RideRecord): Promise<UpsertRideResult> {
  const { rows } = await query<{ id: string; inserted: boolean }>(
    `INSERT INTO public.rides
       (date, started_at, start_lat, start_lng, block, week, distance_km,
        duration_s, avg_hr, max_hr, avg_speed_kmh, max_speed_kmh,
        elevation_gain_m, bike_used, external_id, source, origin,
        avg_power_w, max_power_w, weighted_avg_power_w, kilojoules,
        power_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
             $18,$19,$20,$21,$22)
     ON CONFLICT (source, external_id) DO UPDATE SET
       ${upsertSetKeepingCorrections('rides')}
     RETURNING id, (xmax = 0) AS inserted`,
    [
      r.date,
      r.started_at,
      r.start_lat,
      r.start_lng,
      r.block,
      r.week,
      r.distance_km,
      r.duration_s,
      r.avg_hr,
      r.max_hr,
      r.avg_speed_kmh,
      r.max_speed_kmh,
      r.elevation_gain_m,
      r.bike_used,
      r.external_id,
      r.source,
      r.origin,
      r.avg_power_w,
      r.max_power_w,
      r.weighted_avg_power_w,
      r.kilojoules,
      r.power_source,
    ],
  );
  const row = rows[0]!;
  return { id: row.id, status: row.inserted ? 'inserted' : 'updated' };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function backfillHistoricalRides(
  opts: RideBackfillOptions = {},
): Promise<RideBackfillSummary> {
  const perPage = opts.perPage ?? STRAVA_MAX_PER_PAGE;
  const resolveGear = opts.resolveGear ?? true;
  const withStreams = opts.withStreams ?? true;
  const pageDelayMs = opts.pageDelayMs ?? 250;
  const maxPages = opts.maxPages ?? 100;

  const accessToken = await getValidAccessToken();
  const gearCache = new Map<string, ResolvedGear | null>();

  const summary: RideBackfillSummary = {
    pagesFetched: 0,
    activitiesSeen: 0,
    ridesInserted: 0,
    ridesUpdated: 0,
    skippedNonRide: 0,
    ridesSkippedExisting: 0,
    ridesSuperseded: 0,
    streamsFetched: 0,
    rateLimited: false,
  };

  try {
    for (let page = 1; page <= maxPages; page++) {
      const activities = await listActivitiesPage(accessToken, {
        page,
        perPage,
        after: opts.after,
        before: opts.before,
      });
      summary.pagesFetched++;
      if (activities.length === 0) break;

      for (const activity of activities) {
        summary.activitiesSeen++;
        if (!isIngestableRide(activity)) {
          summary.skippedNonRide++;
          continue;
        }

        let bike: ResolvedGear | null = null;
        if (resolveGear && activity.gear_id) {
          bike = await resolveStravaBikeGear(
            accessToken,
            activity.gear_id,
            gearCache,
          );
        }

        const ride = mapActivityToRide(activity, {
          bikeName: bike?.name ?? null,
        });
        // Source priority (MZY-225) — same rule as the run ingest.
        const overlap = await classifyIncomingActivity('ride', ride);
        const winner = overlap.blocking[0];
        if (winner) {
          summary.ridesSkippedExisting++;
          if (withStreams && !(await hasRideStreams(winner.id, 'strava'))) {
            const streams = await fetchStravaRunStreams(
              accessToken,
              activity.id,
            );
            if (streams) {
              await upsertRideStreams(
                winner.id,
                'strava',
                withStravaWattsSource(streams, activity.device_watts),
              );
              summary.streamsFetched++;
            }
          }
          continue;
        }

        const result = await upsertRide(ride);
        if (result.status === 'inserted') summary.ridesInserted++;
        else summary.ridesUpdated++;
        summary.ridesSuperseded += await supersedeActivities(
          'ride',
          result.id,
          overlap.supersede,
        );

        if (bike) await linkRideGear(result.id, bike.gearId);
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

        // Full time series regardless of HR: GPS, speed and the moving flag
        // matter even for a ride recorded without the HRM.
        if (withStreams && !(await hasRideStreams(result.id, 'strava'))) {
          const streams = await fetchStravaRunStreams(accessToken, activity.id);
          if (streams) {
            await upsertRideStreams(
              result.id,
              'strava',
              withStravaWattsSource(streams, activity.device_watts),
            );
            summary.streamsFetched++;
          }
        }
      }

      if (activities.length < perPage) break;
      await sleep(pageDelayMs);
    }
  } catch (err) {
    if (err instanceof StravaRateLimitError) {
      summary.rateLimited = true;
      logger.warn('strava ride backfill stopped on rate limit — resume later', {
        job: 'strava-ride-backfill',
        ...summary,
      });
      return summary;
    }
    throw err;
  }

  logger.info('strava ride backfill complete', {
    job: 'strava-ride-backfill',
    ...summary,
  });
  return summary;
}

interface ResolvedGear {
  gearId: string;
  name: string;
}

/** Resolve a Strava gear_id to a bike catalog entry. Mirrors resolveStravaGear in ingest.ts (category 'bike' instead of 'shoe'). */
async function resolveStravaBikeGear(
  accessToken: string,
  stravaGearId: string,
  cache: Map<string, ResolvedGear | null>,
): Promise<ResolvedGear | null> {
  const cached = cache.get(stravaGearId);
  if (cached !== undefined) return cached;

  let resolved: ResolvedGear | null = null;
  try {
    const name = await getGearName(accessToken, stravaGearId);
    await upsertGear({
      gear_id: stravaGearId,
      name,
      source: 'strava',
      category: 'bike',
    });
    resolved = { gearId: stravaGearId, name };
  } catch (err) {
    if (err instanceof StravaRateLimitError) throw err;
    logger.warn('strava bike gear lookup failed — leaving bike null', {
      job: 'strava-ride-backfill',
      gearId: stravaGearId,
    });
  }
  cache.set(stravaGearId, resolved);
  return resolved;
}
