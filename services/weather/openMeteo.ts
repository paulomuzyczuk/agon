import { z } from 'zod';
import { wmoWeatherDescription } from '../../lib/weatherCodes';

// Open-Meteo weather lookup for a run's start instant + GPS. Free and keyless.
// Two endpoints share one response shape: the ERA5 `archive` API (full history
// but lags ~5 days) and the `forecast` API (recent past via past_days + future).
// We pick by recency so both a months-old backfill and a run from this morning
// resolve. Units are Open-Meteo defaults: °C, %, km/h.

const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const HOURLY =
  'temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code';
// The archive reanalysis trails real time; anything more recent must come from
// the forecast endpoint's past_days window.
const ARCHIVE_LAG_DAYS = 6;

export class OpenMeteoRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenMeteoRateLimitError';
  }
}

const hourlySchema = z.object({
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: z.array(z.number().nullable()),
    relative_humidity_2m: z.array(z.number().nullable()),
    wind_speed_10m: z.array(z.number().nullable()),
    weather_code: z.array(z.number().nullable()),
  }),
});

export interface RunWeather {
  tempC: number | null;
  humidityPct: number | null;
  windKph: number | null;
  conditions: string | null;
}

function round(v: number | null, dp: number): number | null {
  if (v == null) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Archive (>ARCHIVE_LAG_DAYS old) vs. forecast endpoint, by recency of `atMs`. */
function endpointFor(atMs: number, nowMs: number): string {
  const ageDays = (nowMs - atMs) / 86_400_000;
  return ageDays > ARCHIVE_LAG_DAYS ? ARCHIVE_URL : FORECAST_URL;
}

async function fetchHourly(
  base: string,
  lat: number,
  lng: number,
  date: string,
  hourlyParams: string,
): ReturnType<typeof fetch> {
  const qs = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    start_date: date,
    end_date: date,
    hourly: hourlyParams,
    timezone: 'UTC', // hourly[i] is UTC hour i, so index == UTC hour-of-day
  });
  const res = await fetch(`${base}?${qs.toString()}`);
  if (res.status === 429) {
    throw new OpenMeteoRateLimitError(
      'open-meteo: rate limit hit (HTTP 429) — back off and resume later',
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `open-meteo: request failed (${res.status} ${res.statusText}) ${text}`,
    );
  }
  return res;
}

/**
 * Weather at a run's start. Returns null if the provider has no data for that
 * hour (e.g. a run too recent for the archive and outside forecast coverage).
 * `nowMs` is injectable for testing the endpoint-selection boundary.
 */
export async function fetchRunWeather(
  lat: number,
  lng: number,
  startedAtISO: string,
  nowMs: number = Date.now(),
): Promise<RunWeather | null> {
  const started = Date.parse(startedAtISO);
  if (Number.isNaN(started)) {
    throw new Error(`openMeteo: invalid started_at '${startedAtISO}'`);
  }
  const startedDate = new Date(started);
  const date = startedDate.toISOString().slice(0, 10); // UTC day
  const hour = startedDate.getUTCHours();

  const res = await fetchHourly(
    endpointFor(started, nowMs),
    lat,
    lng,
    date,
    HOURLY,
  );
  const { hourly } = hourlySchema.parse(await res.json());
  if (hour >= hourly.time.length) return null; // no row for that hour

  return {
    tempC: round(hourly.temperature_2m[hour] ?? null, 1),
    humidityPct: round(hourly.relative_humidity_2m[hour] ?? null, 1),
    windKph: round(hourly.wind_speed_10m[hour] ?? null, 1),
    conditions: wmoWeatherDescription(hourly.weather_code[hour] ?? null),
  };
}

// ── Route forecast (services/routing weather-weighted ranking) ────────────────
// Same archive-vs-forecast endpoint selection as fetchRunWeather, plus wind
// DIRECTION (fetchRunWeather doesn't need it — a run already happened, only its
// speed/temp are recorded; a route being RANKED needs direction to compare
// candidate bearings against). Kept as a separate function/schema rather than
// widening RunWeather, so fetchRunWeather's shape (and the runs.* columns it
// feeds) is untouched.

const routeHourlySchema = z.object({
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: z.array(z.number().nullable()),
    wind_speed_10m: z.array(z.number().nullable()),
    wind_direction_10m: z.array(z.number().nullable()),
    weather_code: z.array(z.number().nullable()),
  }),
});

export interface RouteForecast {
  tempC: number | null;
  windKph: number | null;
  /** Meteorological convention: the direction the wind is blowing FROM. */
  windFromDeg: number | null;
  conditions: string | null;
}

/**
 * Forecast for a route's start location + start instant — the ranking-facing
 * counterpart to fetchRunWeather. Returns null if the provider has no data for
 * that hour. `nowMs` is injectable for testing the endpoint-selection boundary.
 */
export async function fetchRouteForecast(
  lat: number,
  lng: number,
  atISO: string,
  nowMs: number = Date.now(),
): Promise<RouteForecast | null> {
  const at = Date.parse(atISO);
  if (Number.isNaN(at)) {
    throw new Error(`openMeteo: invalid instant '${atISO}'`);
  }
  const atDate = new Date(at);
  const date = atDate.toISOString().slice(0, 10);
  const hour = atDate.getUTCHours();

  const res = await fetchHourly(
    endpointFor(at, nowMs),
    lat,
    lng,
    date,
    'temperature_2m,wind_speed_10m,wind_direction_10m,weather_code',
  );
  const { hourly } = routeHourlySchema.parse(await res.json());
  if (hour >= hourly.time.length) return null;

  return {
    tempC: round(hourly.temperature_2m[hour] ?? null, 1),
    windKph: round(hourly.wind_speed_10m[hour] ?? null, 1),
    windFromDeg: hourly.wind_direction_10m[hour] ?? null,
    conditions: wmoWeatherDescription(hourly.weather_code[hour] ?? null),
  };
}
