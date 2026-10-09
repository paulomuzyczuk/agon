import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { finishLiveRecordingRide } from '@/services/liveRecordingRide';
import { MERIDA_SILEX_400 } from '@/lib/gear';

// Integration lane (agon_test). A live-recorded ride links the bike BY NAME:
// once Strava's gear sync has stored "Merida Silex 400" under its own id, the
// flush must reuse that row. Minting a second 'local:' row with the same name
// hits idx_gear_name_ci and failed every ride save (found in MZY-279's phone
// test).

const RECORDING_ID = 'itest-live-ride-strava-bike';
const STARTED_AT = Date.parse('2020-03-02T09:00:00Z');
const STRAVA_BIKE_ID = 'itest-b-merida';

let existingBike: { gear_id: string } | undefined;

beforeAll(async () => {
  loadEnv();
  const { rows } = await query<{ gear_id: string }>(
    'SELECT gear_id FROM public.gear WHERE lower(name) = lower($1)',
    [MERIDA_SILEX_400.name],
  );
  existingBike = rows[0];
  if (!existingBike) {
    await query(
      `INSERT INTO public.gear (gear_id, name, source, category)
       VALUES ($1, $2, 'strava', 'bike')`,
      [STRAVA_BIKE_ID, MERIDA_SILEX_400.name],
    );
  }
});

afterAll(async () => {
  await query(
    `DELETE FROM public.rides WHERE source = 'live_recording' AND external_id = $1`,
    [RECORDING_ID],
  );
  if (!existingBike) {
    await query('DELETE FROM public.gear WHERE gear_id = $1', [STRAVA_BIKE_ID]);
  }
  await closeDbPool();
});

describe('finishLiveRecordingRide — bike link', () => {
  it('links the bike row Strava already created instead of minting a duplicate', async () => {
    const bikeId = existingBike?.gear_id ?? STRAVA_BIKE_ID;
    const hr = Array.from({ length: 60 }, (_, s) => ({
      tMs: STARTED_AT + s * 1000,
      bpm: 120,
    }));
    const { rideId } = await finishLiveRecordingRide({
      recordingId: RECORDING_ID,
      startedAt: STARTED_AT,
      endedAt: STARTED_AT + 60_000,
      samples: { hr, speed: [], cadence: [], power: [] },
      distanceKm: 0.5,
    });

    const { rows: links } = await query<{ gear_id: string }>(
      'SELECT gear_id FROM public.ride_gear WHERE ride_id = $1',
      [rideId],
    );
    expect(links).toEqual([{ gear_id: bikeId }]);

    const { rows: bikes } = await query(
      'SELECT gear_id FROM public.gear WHERE lower(name) = lower($1)',
      [MERIDA_SILEX_400.name],
    );
    expect(bikes).toHaveLength(1);
  });
});
