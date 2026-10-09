import { query } from '../db';
import { logger } from '../logger';
import { homeLocationOrNull } from '../routing/config';
import {
  fetchRunWeather,
  OpenMeteoRateLimitError,
  type RunWeather,
} from './openMeteo';

// Weather enrichment of runs and rides. Writes the weather columns (temp_c,
// humidity_pct, wind_kph, weather_conditions, weather_location_estimated) —
// the ingest upserts deliberately never touch these, so re-running a backfill
// won't clobber enrichment.
//
// Location: the activity's GPS start. Without one (HR-only Agon live
// recordings, voice-note manual runs), the athlete's home (AGON_HOME_LAT/LNG in
// .env.local, shared with route planning) stands in, flagged
// weather_location_estimated (MZY-226); a
// flagged row is re-fetched once the activity gains a real GPS start.

type ActivityTable = 'runs' | 'rides';

async function updateWeather(
  table: ActivityTable,
  id: string,
  w: RunWeather,
  estimated: boolean,
): Promise<void> {
  await query(
    `UPDATE public.${table}
        SET temp_c = $2, humidity_pct = $3, wind_kph = $4, weather_conditions = $5,
            weather_location_estimated = $6
      WHERE id = $1`,
    [id, w.tempC, w.humidityPct, w.windKph, w.conditions, estimated],
  );
}

/** Write the fetched weather onto a run row (fetched at its real GPS start). */
export function updateRunWeather(runId: string, w: RunWeather): Promise<void> {
  return updateWeather('runs', runId, w, false);
}

/** Write the fetched weather onto a ride row (fetched at its real GPS start). */
export function updateRideWeather(
  rideId: string,
  w: RunWeather,
): Promise<void> {
  return updateWeather('rides', rideId, w, false);
}

export interface WeatherBackfillSummary {
  candidates: number;
  enriched: number;
  /** of `enriched`, how many used the home-location fallback. */
  estimated: number;
  noData: number;
  rateLimited: boolean;
}

export interface WeatherBackfillOptions {
  force?: boolean;
  requestDelayMs?: number;
  /**
   * Fallback location for activities with no GPS start. Defaults to home
   * (AGON_HOME_LAT/LNG); `null` disables the fallback.
   */
  fallback?: { lat: number; lng: number } | null;
  /** Only these activity ids (e.g. one hand-corrected activity). */
  ids?: readonly string[];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Enrich every activity in `table` that has a start time and a location (GPS
 * start, else the fallback) but no weather yet — plus fallback-estimated rows
 * that have since gained a real GPS start. Idempotent + resumable; `force`
 * re-fetches everything locatable.
 */
async function backfillTableWeather(
  table: ActivityTable,
  opts: WeatherBackfillOptions,
): Promise<WeatherBackfillSummary> {
  const requestDelayMs = opts.requestDelayMs ?? 200;
  const fallback =
    opts.fallback === undefined ? homeLocationOrNull() : opts.fallback;

  const { rows } = await query<{
    id: string;
    lat: number;
    lng: number;
    started_at: Date;
    estimated: boolean;
  }>(
    `SELECT id,
            COALESCE(start_lat, $1::float8) AS lat,
            COALESCE(start_lng, $2::float8) AS lng,
            started_at,
            start_lat IS NULL AS estimated
       FROM public.${table}
      WHERE started_at IS NOT NULL
        AND (start_lat IS NOT NULL OR $1::float8 IS NOT NULL)
        AND ($3 OR temp_c IS NULL
                OR (weather_location_estimated AND start_lat IS NOT NULL))
        AND ($4::uuid[] IS NULL OR id = ANY($4::uuid[]))
      ORDER BY started_at`,
    [
      fallback?.lat ?? null,
      fallback?.lng ?? null,
      opts.force ?? false,
      opts.ids ?? null,
    ],
  );

  const summary: WeatherBackfillSummary = {
    candidates: rows.length,
    enriched: 0,
    estimated: 0,
    noData: 0,
    rateLimited: false,
  };
  const job = table === 'runs' ? 'weather-backfill' : 'weather-backfill-rides';

  try {
    for (const row of rows) {
      const weather = await fetchRunWeather(
        row.lat,
        row.lng,
        row.started_at.toISOString(),
      );
      if (!weather) {
        summary.noData++;
        continue;
      }
      await updateWeather(table, row.id, weather, row.estimated);
      summary.enriched++;
      if (row.estimated) summary.estimated++;
      await sleep(requestDelayMs);
    }
  } catch (err) {
    if (err instanceof OpenMeteoRateLimitError) {
      summary.rateLimited = true;
      logger.warn(`${job} stopped on rate limit — resume later`, {
        job,
        ...summary,
      });
      return summary;
    }
    throw err;
  }

  logger.info(`${job} complete`, { job, ...summary });
  return summary;
}

export function backfillWeather(
  opts: WeatherBackfillOptions = {},
): Promise<WeatherBackfillSummary> {
  return backfillTableWeather('runs', opts);
}

export function backfillRideWeather(
  opts: WeatherBackfillOptions = {},
): Promise<WeatherBackfillSummary> {
  return backfillTableWeather('rides', opts);
}

/**
 * The post-sync hook (MZY-226): fill weather for any run/ride still missing it.
 * Called at the end of every sync entry point (sync scripts, Telegram /sync,
 * live-recording finish), so weather no longer waits for a manual
 * `pnpm weather:backfill`. Best-effort — a weather failure is logged and never
 * fails the sync that called it. Cheap in steady state: only gaps are fetched.
 */
export async function enrichMissingWeather(): Promise<void> {
  try {
    await backfillWeather();
    await backfillRideWeather();
  } catch (err) {
    logger.warn('post-sync weather enrichment failed — will retry next sync', {
      job: 'weather-post-sync',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Re-fetch one activity's weather at its current start — after a hand
 * correction moved started_at (MZY-253). Best-effort, like the post-sync hook:
 * a failure is logged, never thrown.
 */
export async function refreshActivityWeather(
  kind: 'run' | 'ride',
  id: string,
): Promise<void> {
  try {
    await backfillTableWeather(kind === 'run' ? 'runs' : 'rides', {
      force: true,
      ids: [id],
      requestDelayMs: 0,
    });
  } catch (err) {
    logger.warn('weather refresh after correction failed', {
      job: 'weather-correction',
      kind,
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
