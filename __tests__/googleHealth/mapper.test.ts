import {
  isRunExerciseType,
  isIngestableExercise,
  mapExerciseToRun,
  isCyclingExerciseType,
  isIngestableCyclingExercise,
  mapExerciseToRide,
  parseDurationSeconds,
  dataPointExternalId,
  localStartDate,
} from '@/services/googleHealth/mapper';
import type { ExerciseDataPoint } from '@/services/googleHealth/types';

function dataPoint(
  over: Partial<ExerciseDataPoint['exercise']> = {},
  name = 'users/me/dataTypes/exercise/dataPoints/dp-123',
): ExerciseDataPoint {
  return {
    name,
    exercise: {
      interval: {
        startTime: '2026-07-24T04:00:00Z', // 06:00 local at UTC+2
        endTime: '2026-07-24T04:50:00Z',
        startUtcOffset: '7200s', // +2h (Berlin summer)
      },
      exerciseType: 'RUNNING',
      activeDuration: '3000s', // 50:00 → 300 s/km over 10 km
      metricsSummary: {
        distanceMillimeters: 10_000_000, // 10 km
        averageHeartRateBeatsPerMinute: 150,
        maxHeartRateBeatsPerMinute: 171,
        elevationGainMillimeters: 42_400,
      },
      exerciseMetadata: { hasGps: true },
      ...over,
    },
  };
}

describe('parseDurationSeconds', () => {
  it('parses integer and fractional Durations', () => {
    expect(parseDurationSeconds('1500s')).toBe(1500);
    expect(parseDurationSeconds('3.5s')).toBe(3.5);
  });
  it('returns null for absent/malformed values', () => {
    expect(parseDurationSeconds(undefined)).toBeNull();
    expect(parseDurationSeconds('1500')).toBeNull();
    expect(parseDurationSeconds('abc')).toBeNull();
  });
});

describe('dataPointExternalId', () => {
  it('takes the trailing segment of the resource name', () => {
    expect(dataPointExternalId(dataPoint())).toBe('dp-123');
  });
  it('is null when the name is absent', () => {
    const dp = dataPoint();
    delete dp.name;
    expect(dataPointExternalId(dp)).toBeNull();
  });
});

describe('isRunExerciseType', () => {
  it('matches running variants case/prefix-insensitively', () => {
    expect(isRunExerciseType('RUNNING')).toBe(true);
    expect(isRunExerciseType('RUNNING_TREADMILL')).toBe(true);
    expect(isRunExerciseType('EXERCISE_TYPE_TRAIL_RUNNING')).toBe(true);
  });
  it('rejects non-runs', () => {
    expect(isRunExerciseType('CYCLING')).toBe(false);
    expect(isRunExerciseType('WALKING')).toBe(false);
  });
});

describe('localStartDate', () => {
  it('shifts the UTC instant by the offset to get the local calendar day', () => {
    // 23:30Z on the 24th at UTC+2 is 01:30 local on the 25th.
    expect(localStartDate('2026-07-24T23:30:00Z', '7200s')).toBe('2026-07-25');
  });
  it('falls back to the UTC day when no offset is given', () => {
    expect(localStartDate('2026-07-24T10:00:00Z', undefined)).toBe(
      '2026-07-24',
    );
  });
});

describe('isIngestableExercise', () => {
  it('accepts a run with positive distance + duration + an id', () => {
    expect(isIngestableExercise(dataPoint())).toBe(true);
  });
  it('rejects non-runs', () => {
    expect(isIngestableExercise(dataPoint({ exerciseType: 'CYCLING' }))).toBe(
      false,
    );
  });
  it('rejects zero-distance runs', () => {
    expect(
      isIngestableExercise(
        dataPoint({ metricsSummary: { distanceMillimeters: 0 } }),
      ),
    ).toBe(false);
  });
  it('rejects a run with no resolvable external id', () => {
    const dp = dataPoint();
    delete dp.name;
    expect(isIngestableExercise(dp)).toBe(false);
  });
  it('uses the interval when activeDuration is absent', () => {
    const dp = dataPoint({ activeDuration: undefined });
    expect(isIngestableExercise(dp)).toBe(true); // 50 min from start/end
  });
});

describe('mapExerciseToRun', () => {
  it('maps objective fields, derives pace, and stamps block/week', () => {
    const run = mapExerciseToRun(dataPoint(), {
      startLat: 52.52,
      startLng: 13.405,
    });
    expect(run).toMatchObject({
      date: '2026-07-24', // athlete-local (UTC+2), not the 04:00Z-only reading
      started_at: '2026-07-24T04:00:00.000Z',
      distance_km: 10,
      duration_s: 3000,
      avg_pace_s_per_km: 300,
      avg_hr: 150,
      max_hr: 171,
      elevation_gain_m: 42.4,
      start_lat: 52.52,
      start_lng: 13.405,
      strava_activity_id: null,
      external_id: 'dp-123',
      source: 'google_health',
      origin: null, // dataPoint() sets no dataSource
    });
  });

  it('captures the upstream platform as lowercased origin', () => {
    const dp = dataPoint();
    dp.dataSource = {
      platform: 'HEALTH_CONNECT',
      recordingMethod: 'ACTIVELY_MEASURED',
    };
    expect(mapExerciseToRun(dp).origin).toBe('health_connect');
    dp.dataSource = { platform: 'FITBIT' };
    expect(mapExerciseToRun(dp).origin).toBe('fitbit');
  });

  it('nulls start GPS when the route was not resolved', () => {
    const run = mapExerciseToRun(dataPoint());
    expect(run.start_lat).toBeNull();
    expect(run.start_lng).toBeNull();
  });

  it('handles a run with no HR', () => {
    const run = mapExerciseToRun(
      dataPoint({ metricsSummary: { distanceMillimeters: 5_000_000 } }),
    );
    expect(run.avg_hr).toBeNull();
    expect(run.max_hr).toBeNull();
    expect(run.distance_km).toBe(5);
  });

  it('leaves qualitative + weather fields null for later pipelines', () => {
    const run = mapExerciseToRun(dataPoint());
    expect(run.fueling).toBeNull();
    expect(run.perceived_effort).toBeNull();
    expect(run.general_notes).toBeNull();
    expect(run.temp_c).toBeNull();
    expect(run.weather_conditions).toBeNull();
  });
});

function rideDataPoint(
  over: Partial<ExerciseDataPoint['exercise']> = {},
  name = 'users/me/dataTypes/exercise/dataPoints/dp-456',
): ExerciseDataPoint {
  return dataPoint(
    {
      exerciseType: 'CYCLING',
      metricsSummary: {
        distanceMillimeters: 20_000_000, // 20 km
        averageHeartRateBeatsPerMinute: 135,
        elevationGainMillimeters: 80_000,
        averageSpeedMillimetersPerSecond: 6940, // 6.94 m/s -> 25 km/h
      },
      ...over,
    },
    name,
  );
}

describe('isCyclingExerciseType', () => {
  it('matches cycling variants case/prefix-insensitively', () => {
    expect(isCyclingExerciseType('CYCLING')).toBe(true);
    expect(isCyclingExerciseType('BIKING')).toBe(true);
    expect(isCyclingExerciseType('EXERCISE_TYPE_MOUNTAIN_BIKING')).toBe(true);
  });
  it('rejects non-cycling', () => {
    expect(isCyclingExerciseType('RUNNING')).toBe(false);
    expect(isCyclingExerciseType('WALKING')).toBe(false);
  });
});

describe('isIngestableCyclingExercise', () => {
  it('accepts a ride with positive distance + duration + an id', () => {
    expect(isIngestableCyclingExercise(rideDataPoint())).toBe(true);
  });
  it('rejects non-rides', () => {
    expect(
      isIngestableCyclingExercise(rideDataPoint({ exerciseType: 'RUNNING' })),
    ).toBe(false);
  });
  it('rejects zero-distance rides', () => {
    expect(
      isIngestableCyclingExercise(
        rideDataPoint({ metricsSummary: { distanceMillimeters: 0 } }),
      ),
    ).toBe(false);
  });
});

describe('mapExerciseToRide', () => {
  it('maps objective fields, derives speed (not pace), and stamps block/week', () => {
    const ride = mapExerciseToRide(rideDataPoint(), {
      startLat: 52.52,
      startLng: 13.405,
    });
    expect(ride).toMatchObject({
      date: '2026-07-24',
      started_at: '2026-07-24T04:00:00.000Z',
      distance_km: 20,
      duration_s: 3000,
      avg_speed_kmh: 24.98, // 6940 mm/s -> 6.94 m/s * 3.6
      avg_hr: 135,
      elevation_gain_m: 80,
      start_lat: 52.52,
      start_lng: 13.405,
      external_id: 'dp-456',
      source: 'google_health',
    });
    expect(ride).not.toHaveProperty('avg_pace_s_per_km');
  });

  it('derives avg speed from distance/duration when averageSpeed is absent', () => {
    const ride = mapExerciseToRide(
      rideDataPoint({
        metricsSummary: { distanceMillimeters: 20_000_000 },
      }),
    );
    expect(ride.avg_speed_kmh).toBe(24); // 20 km / 3000 s * 3600
  });

  it('leaves qualitative + weather fields null for later pipelines', () => {
    const ride = mapExerciseToRide(rideDataPoint());
    expect(ride.perceived_effort).toBeNull();
    expect(ride.general_notes).toBeNull();
    expect(ride.temp_c).toBeNull();
    expect(ride.weather_conditions).toBeNull();
  });
});
