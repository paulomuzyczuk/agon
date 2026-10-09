import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { updateRunWeather } from '@/services/weather/enrich';
import { upsertRun } from '@/services/strava/ingest';
import type { RunRecord } from '@/lib/types';

// Integration lane. Proves weather enrichment writes the runs weather columns
// (no network — updateRunWeather is the DB half; the Open-Meteo fetch is unit-
// tested with a mock and exercised live via the enrich-weather script).

const RUN_ID = 999_000_111_555;

function run(): RunRecord {
  return {
    date: '2026-03-25',
    started_at: '2026-03-25T09:00:00.000Z',
    start_lat: -23.55,
    start_lng: -46.63,
    block: 1,
    week: 1,
    distance_km: 10,
    duration_s: 3000,
    avg_hr: 150,
    max_hr: 171,
    avg_pace_s_per_km: 300,
    elevation_gain_m: 42,
    shoe_used: null,
    fueling: null,
    perceived_effort: null,
    pain_location: null,
    pain_onset_km: null,
    general_notes: null,
    strava_activity_id: RUN_ID,
    external_id: String(RUN_ID),
    source: 'strava',
    origin: null,
    temp_c: null,
    humidity_pct: null,
    wind_kph: null,
    weather_conditions: null,
  };
}

beforeAll(() => loadEnv());
afterEach(async () => {
  await query('DELETE FROM public.runs WHERE strava_activity_id = $1', [
    RUN_ID,
  ]);
});
afterAll(() => closeDbPool());

describe('weather enrichment', () => {
  it('writes weather onto the run and leaves the Strava upsert non-clobbering', async () => {
    const { id } = await upsertRun(run());
    await updateRunWeather(id, {
      tempC: 24.5,
      humidityPct: 78,
      windKph: 11.2,
      conditions: 'Overcast',
    });

    // Re-running the Strava backfill must NOT wipe the enriched weather.
    await upsertRun(run());

    const { rows } = await query<{
      temp_c: string;
      humidity_pct: string;
      wind_kph: string;
      weather_conditions: string;
      start_lat: string;
    }>(
      `SELECT temp_c, humidity_pct, wind_kph, weather_conditions, start_lat
         FROM public.runs WHERE strava_activity_id = $1`,
      [RUN_ID],
    );
    const row = rows[0]!;
    expect(Number(row.temp_c)).toBe(24.5);
    expect(Number(row.humidity_pct)).toBe(78);
    expect(Number(row.wind_kph)).toBe(11.2);
    expect(row.weather_conditions).toBe('Overcast');
    expect(Number(row.start_lat)).toBe(-23.55); // GPS persisted from upsert
  });
});
