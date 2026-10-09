import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { backfillWeather } from '@/services/weather/enrich';
import { upsertRun } from '@/services/strava/ingest';
import { fetchRunWeather } from '@/services/weather/openMeteo';
import type { RunRecord } from '@/lib/types';

// Integration lane (agon_test DB) for the home-location weather fallback
// (MZY-226). Open-Meteo is mocked — this proves the SQL: which rows are picked,
// with which coordinates, and how the estimated flag is set and later cleared.

jest.mock('@/services/weather/openMeteo', () => ({
  ...jest.requireActual('@/services/weather/openMeteo'),
  fetchRunWeather: jest.fn(),
}));
const fetchMock = fetchRunWeather as jest.MockedFunction<
  typeof fetchRunWeather
>;

const EXT = 'mzy226-no-gps';
const HOME = { lat: 52.52, lng: 13.405 };

function gpsLessRun(): RunRecord {
  return {
    date: '2020-03-03',
    started_at: '2020-03-03T09:00:00.000Z',
    start_lat: null,
    start_lng: null,
    block: 1,
    week: 1,
    distance_km: 8,
    duration_s: 2400,
    avg_hr: 140,
    max_hr: 160,
    avg_pace_s_per_km: 300,
    elevation_gain_m: null,
    shoe_used: null,
    fueling: null,
    perceived_effort: null,
    pain_location: null,
    pain_onset_km: null,
    general_notes: null,
    strava_activity_id: null,
    external_id: EXT,
    source: 'live_recording',
    origin: null,
    temp_c: null,
    humidity_pct: null,
    wind_kph: null,
    weather_conditions: null,
  };
}

const own = async () =>
  (
    await query<{ temp_c: string | null; weather_location_estimated: boolean }>(
      `SELECT temp_c, weather_location_estimated FROM public.runs WHERE external_id = $1`,
      [EXT],
    )
  ).rows[0]!;

beforeAll(() => loadEnv());
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (lat) => ({
    tempC: lat === HOME.lat ? 11 : 14,
    humidityPct: 70,
    windKph: 10,
    conditions: 'Overcast',
  }));
});
afterEach(async () => {
  await query('DELETE FROM public.runs WHERE external_id = $1', [EXT]);
});
afterAll(() => closeDbPool());

describe('weather home-location fallback', () => {
  it('skips a GPS-less run when no fallback is configured', async () => {
    await upsertRun(gpsLessRun());
    await backfillWeather({ fallback: null, requestDelayMs: 0 });
    expect((await own()).temp_c).toBeNull();
  });

  it('fills a GPS-less run at the home location, flagged estimated', async () => {
    await upsertRun(gpsLessRun());
    await backfillWeather({ fallback: HOME, requestDelayMs: 0 });
    expect(fetchMock).toHaveBeenCalledWith(
      HOME.lat,
      HOME.lng,
      '2020-03-03T09:00:00.000Z',
    );
    expect(await own()).toEqual({
      temp_c: '11.0',
      weather_location_estimated: true,
    });
  });

  it('re-fetches at the real GPS start once the run gains one, clearing the flag', async () => {
    await upsertRun(gpsLessRun());
    await backfillWeather({ fallback: HOME, requestDelayMs: 0 });
    await query(
      `UPDATE public.runs SET start_lat = 52.49, start_lng = 13.32 WHERE external_id = $1`,
      [EXT],
    );
    await backfillWeather({ fallback: null, requestDelayMs: 0 });
    expect(fetchMock).toHaveBeenLastCalledWith(
      52.49,
      13.32,
      '2020-03-03T09:00:00.000Z',
    );
    expect(await own()).toEqual({
      temp_c: '14.0',
      weather_location_estimated: false,
    });
  });
});
