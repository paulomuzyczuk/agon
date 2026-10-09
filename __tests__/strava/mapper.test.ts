import {
  isRunActivity,
  isIngestableRun,
  mapActivityToRun,
  isRideActivity,
  isIngestableRide,
  mapActivityToRide,
  isFromIgnoredDevice,
  powerFields,
} from '@/services/strava/mapper';
import type { StravaSummaryActivity } from '@/services/strava/types';

function activity(
  overrides: Partial<StravaSummaryActivity> = {},
): StravaSummaryActivity {
  return {
    id: 987654321,
    name: 'Morning Run',
    distance: 10000, // 10 km
    moving_time: 3000, // 50:00 → 300 s/km
    elapsed_time: 3100,
    total_elevation_gain: 42.4,
    sport_type: 'Run',
    type: 'Run',
    start_date: '2026-03-25T09:00:00Z',
    start_date_local: '2026-03-25T06:00:00Z',
    average_heartrate: 150.6,
    max_heartrate: 171.2,
    gear_id: 'g111',
    start_latlng: [-23.55, -46.63],
    ...overrides,
  };
}

describe('isRunActivity / isIngestableRun', () => {
  it('accepts Run and TrailRun sport types', () => {
    expect(isRunActivity(activity({ sport_type: 'Run' }))).toBe(true);
    expect(isRunActivity(activity({ sport_type: 'TrailRun' }))).toBe(true);
  });

  it('rejects non-run activities', () => {
    expect(isRunActivity(activity({ sport_type: 'Ride', type: 'Ride' }))).toBe(
      false,
    );
  });

  it('falls back to legacy `type` when sport_type is absent', () => {
    expect(
      isRunActivity(activity({ sport_type: undefined, type: 'Run' })),
    ).toBe(true);
  });

  it('rejects zero-distance or zero-duration runs as non-ingestable', () => {
    expect(isIngestableRun(activity({ distance: 0 }))).toBe(false);
    expect(isIngestableRun(activity({ moving_time: 0 }))).toBe(false);
    expect(isIngestableRun(activity())).toBe(true);
  });
});

describe('mapActivityToRun', () => {
  it('maps objective fields, derives pace, and stamps block/week', () => {
    const run = mapActivityToRun(activity(), { shoeName: 'Endorphin Speed 4' });
    expect(run).toMatchObject({
      date: '2026-03-25', // athlete-local date, not UTC
      started_at: '2026-03-25T09:00:00.000Z', // UTC instant from start_date
      block: 1,
      week: 1,
      distance_km: 10,
      duration_s: 3000,
      avg_pace_s_per_km: 300,
      avg_hr: 151, // rounded from 150.6
      max_hr: 171, // rounded from 171.2
      elevation_gain_m: 42.4,
      shoe_used: 'Endorphin Speed 4',
      start_lat: -23.55,
      start_lng: -46.63,
      strava_activity_id: 987654321,
      external_id: '987654321', // idempotency key: activity id as text
      source: 'strava',
    });
  });

  it('nulls start GPS for a run recorded without it', () => {
    expect(
      mapActivityToRun(activity({ start_latlng: [] })).start_lat,
    ).toBeNull();
    expect(
      mapActivityToRun(activity({ start_latlng: null })).start_lng,
    ).toBeNull();
  });

  it('leaves qualitative and weather fields null for later pipelines', () => {
    const run = mapActivityToRun(activity());
    expect(run.fueling).toBeNull();
    expect(run.perceived_effort).toBeNull();
    expect(run.pain_location).toBeNull();
    expect(run.general_notes).toBeNull();
    expect(run.temp_c).toBeNull();
    expect(run.weather_conditions).toBeNull();
  });

  it('handles missing HR and gear gracefully', () => {
    const run = mapActivityToRun(
      activity({ average_heartrate: undefined, max_heartrate: undefined }),
    );
    expect(run.avg_hr).toBeNull();
    expect(run.max_hr).toBeNull();
    expect(run.shoe_used).toBeNull();
  });

  it('uses the local date for block assignment across a UTC day boundary', () => {
    // 23:30 local on 2026-03-24 is 2026-03-25 in UTC — block/week must follow local.
    const run = mapActivityToRun(
      activity({
        start_date_local: '2026-03-24T23:30:00Z',
        start_date: '2026-03-25T02:30:00Z',
      }),
    );
    expect(run.date).toBe('2026-03-24');
  });
});

function rideActivity(
  overrides: Partial<StravaSummaryActivity> = {},
): StravaSummaryActivity {
  return activity({
    name: 'Easy Ride',
    sport_type: 'Ride',
    type: 'Ride',
    average_speed: 6.94, // m/s -> 25 km/h
    max_speed: 12.5, // m/s -> 45 km/h
    gear_id: 'b111',
    ...overrides,
  });
}

describe('isRideActivity / isIngestableRide', () => {
  it('accepts Ride and other cycling sport types', () => {
    expect(isRideActivity(rideActivity({ sport_type: 'Ride' }))).toBe(true);
    expect(isRideActivity(rideActivity({ sport_type: 'GravelRide' }))).toBe(
      true,
    );
    expect(
      isRideActivity(rideActivity({ sport_type: 'MountainBikeRide' })),
    ).toBe(true);
  });

  it('rejects non-ride activities', () => {
    expect(isRideActivity(activity({ sport_type: 'Run', type: 'Run' }))).toBe(
      false,
    );
  });

  it('rejects zero-distance or zero-duration rides as non-ingestable', () => {
    expect(isIngestableRide(rideActivity({ distance: 0 }))).toBe(false);
    expect(isIngestableRide(rideActivity({ moving_time: 0 }))).toBe(false);
    expect(isIngestableRide(rideActivity())).toBe(true);
  });
});

describe('ignored recording devices', () => {
  const saved = process.env.STRAVA_IGNORED_DEVICES;
  afterEach(() => {
    if (saved === undefined) delete process.env.STRAVA_IGNORED_DEVICES;
    else process.env.STRAVA_IGNORED_DEVICES = saved;
  });
  const sensorRide = activity({
    sport_type: 'Ride',
    type: 'Ride',
    device_name: 'Garmin Speed Sensor',
    start_latlng: [],
  });

  it('skips Garmin Speed Sensor activities by default', () => {
    delete process.env.STRAVA_IGNORED_DEVICES;
    expect(isIngestableRide(sensorRide)).toBe(false);
    expect(
      isIngestableRun(activity({ device_name: 'Garmin Speed Sensor' })),
    ).toBe(false);
  });

  it('keeps other devices and activities with no device name', () => {
    delete process.env.STRAVA_IGNORED_DEVICES;
    expect(isIngestableRide({ ...sensorRide, device_name: 'Strava App' })).toBe(
      true,
    );
    expect(isIngestableRun(activity({ device_name: undefined }))).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(
      isFromIgnoredDevice(activity({ device_name: 'garmin speed sensor' }), [
        'Garmin Speed Sensor',
      ]),
    ).toBe(true);
  });

  it('honours STRAVA_IGNORED_DEVICES, empty meaning ignore none', () => {
    process.env.STRAVA_IGNORED_DEVICES = '';
    expect(isIngestableRide(sensorRide)).toBe(true);
    process.env.STRAVA_IGNORED_DEVICES = 'Strava App, Wahoo ELEMNT';
    expect(isIngestableRide(sensorRide)).toBe(true);
    expect(
      isIngestableRide({ ...sensorRide, device_name: 'Wahoo ELEMNT' }),
    ).toBe(false);
  });
});

describe('mapActivityToRide', () => {
  it('maps objective fields, derives speed (not pace), and stamps block/week', () => {
    const ride = mapActivityToRide(rideActivity(), {
      bikeName: 'Canyon Endurace',
    });
    expect(ride).toMatchObject({
      date: '2026-03-25',
      block: 1,
      week: 1,
      distance_km: 10,
      duration_s: 3000,
      avg_speed_kmh: 24.98, // 6.94 m/s * 3.6
      max_speed_kmh: 45,
      avg_hr: 151,
      max_hr: 171,
      elevation_gain_m: 42.4,
      bike_used: 'Canyon Endurace',
      external_id: '987654321',
      source: 'strava',
    });
    expect(ride).not.toHaveProperty('avg_pace_s_per_km');
    expect(ride).not.toHaveProperty('shoe_used');
  });

  it('derives avg speed from distance/moving_time when Strava omits average_speed', () => {
    const ride = mapActivityToRide(
      rideActivity({ average_speed: undefined, max_speed: undefined }),
    );
    expect(ride.avg_speed_kmh).toBe(12); // 10 km / 3000 s * 3600
    expect(ride.max_speed_kmh).toBeNull();
  });

  it('leaves qualitative and weather fields null for later pipelines', () => {
    const ride = mapActivityToRide(rideActivity());
    expect(ride.perceived_effort).toBeNull();
    expect(ride.general_notes).toBeNull();
    expect(ride.temp_c).toBeNull();
    expect(ride.weather_conditions).toBeNull();
  });
});

describe('powerFields (MZY-267 power provenance)', () => {
  it("labels Strava's estimate — watts with device_watts false — as 'estimated'", () => {
    const p = powerFields(
      rideActivity({
        average_watts: 112.4,
        kilojoules: 337.25,
        device_watts: false,
      }),
    );
    expect(p).toEqual({
      avg_power_w: 112,
      max_power_w: null,
      weighted_avg_power_w: null,
      kilojoules: 337.3,
      power_source: 'estimated',
    });
  });

  it("treats watts without a device_watts flag as 'estimated', never measured", () => {
    expect(powerFields(rideActivity({ average_watts: 90 })).power_source).toBe(
      'estimated',
    );
  });

  it("labels power-meter rides 'device' and keeps max + weighted watts", () => {
    const p = powerFields(
      rideActivity({
        average_watts: 180,
        weighted_average_watts: 196.6,
        max_watts: 712,
        kilojoules: 648,
        device_watts: true,
      }),
    );
    expect(p).toEqual({
      avg_power_w: 180,
      max_power_w: 712,
      weighted_avg_power_w: 197,
      kilojoules: 648,
      power_source: 'device',
    });
  });

  it('returns all-null power (no provenance) when Strava has no watts', () => {
    expect(powerFields(rideActivity())).toEqual({
      avg_power_w: null,
      max_power_w: null,
      weighted_avg_power_w: null,
      kilojoules: null,
      power_source: null,
    });
    // A bare 0 average with no kJ is Strava's placeholder, not a measurement.
    expect(
      powerFields(rideActivity({ average_watts: 0 })).power_source,
    ).toBeNull();
  });

  it('flows through mapActivityToRide', () => {
    const ride = mapActivityToRide(
      rideActivity({ average_watts: 120, kilojoules: 400 }),
    );
    expect(ride.power_source).toBe('estimated');
    expect(ride.avg_power_w).toBe(120);
  });
});
