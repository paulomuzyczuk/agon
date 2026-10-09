import {
  unionField,
  valueObject,
  wellnessExternalId,
  readNumber,
  readValueStart,
  foldActivityPoints,
  foldRollupPoints,
  accumulatorToRecords,
  mapSleepSession,
  mapDailyHrv,
  structuredDateToISO,
  sessionRangeFilter,
  intervalRangeFilter,
  dailyRangeFilter,
  ACTIVITY_METRICS,
  ROLLUP_METRICS,
  civilDateForLocalDay,
  rollupRangeFor,
  chunkLocalDayRange,
  backfillGoogleHealthWellness,
  type ActivityAccumulator,
  type GoogleHealthWellnessDeps,
} from '@/services/googleHealth/wellness';
import type {
  WellnessDataPoint,
  WellnessDataPointList,
  RollupDataPoint,
  DailyRollUpResponse,
} from '@/services/googleHealth/types';
import { GoogleHealthRateLimitError } from '@/services/googleHealth/client';

// Pure wellness mapping/assembly + orchestrator with fully injected deps — no DB,
// no network. Payload shapes match what the real Google Health API returned
// 2026-07-24 (structured {year,month,day} daily dates; snake_case filter paths;
// active-zone-minutes; HRV avg + deep RMSSD). The tests pin the CONTRACT our
// mappers rely on, so a further live field-name fix is a one-line change here too.

// The athlete's zone is Europe/Berlin (lib/constants ATHLETE_TIME_ZONE); the
// dates below assume CEST (UTC+2) for the July window used here.

describe('unionField', () => {
  it('kebab dataType → camelCase union field', () => {
    expect(unionField('steps')).toBe('steps');
    expect(unionField('active-minutes')).toBe('activeMinutes');
    expect(unionField('daily-resting-heart-rate')).toBe(
      'dailyRestingHeartRate',
    );
    expect(unionField('daily-heart-rate-variability')).toBe(
      'dailyHeartRateVariability',
    );
  });
});

describe('valueObject / wellnessExternalId', () => {
  it('reads the value object under the dataType union field', () => {
    const dp: WellnessDataPoint = {
      name: 'users/me/dataTypes/steps/dataPoints/abc',
      steps: { interval: { startTime: '2026-07-24T10:00:00Z' }, count: 1200 },
    } as unknown as WellnessDataPoint;
    expect(valueObject(dp, 'steps')).toMatchObject({ count: 1200 });
    expect(valueObject(dp, 'sleep')).toBeNull();
  });

  it('external id is the trailing resource-name segment, else null', () => {
    expect(
      wellnessExternalId({
        name: 'users/me/dataTypes/sleep/dataPoints/xyz',
      } as WellnessDataPoint),
    ).toBe('xyz');
    expect(wellnessExternalId({} as WellnessDataPoint)).toBeNull();
  });
});

describe('readNumber', () => {
  it('coerces int64-as-string and tries candidates in order', () => {
    expect(readNumber({ count: '1200' }, ['count'])).toBe(1200);
    expect(readNumber({ beatsPerMinute: 58 }, ['bpm', 'beatsPerMinute'])).toBe(
      58,
    );
  });
  it('returns null when no candidate matches or object is null', () => {
    expect(readNumber({ other: 1 }, ['count'])).toBeNull();
    expect(readNumber(null, ['count'])).toBeNull();
    expect(readNumber({ count: 'not-a-number' }, ['count'])).toBeNull();
  });
});

describe('readValueStart', () => {
  it('prefers interval.startTime, then bare start/time/date', () => {
    expect(
      readValueStart({ interval: { startTime: '2026-07-24T00:00:00Z' } }),
    ).toBe('2026-07-24T00:00:00Z');
    expect(readValueStart({ date: '2026-07-24' })).toBe('2026-07-24');
    expect(readValueStart({})).toBeNull();
  });
});

describe('foldActivityPoints + accumulatorToRecords', () => {
  const spec = (dataType: string) =>
    ACTIVITY_METRICS.find((m) => m.dataType === dataType)!;

  it('sums active-zone-minutes (per-minute, per-zone rows) into the local day', () => {
    const acc: ActivityAccumulator = new Map();
    // Discrete non-overlapping 1-minute buckets, so summing is correct.
    foldActivityPoints(acc, spec('active-zone-minutes'), [
      {
        activeZoneMinutes: {
          interval: { startTime: '2026-07-24T14:49:00Z' },
          heartRateZone: 'FAT_BURN',
          activeZoneMinutes: '1',
        },
      },
      {
        activeZoneMinutes: {
          interval: { startTime: '2026-07-24T14:50:00Z' },
          heartRateZone: 'CARDIO',
          activeZoneMinutes: '2',
        },
      },
    ] as unknown as WellnessDataPoint[]);
    const rec = accumulatorToRecords(acc)[0]!;
    expect(rec).toMatchObject({ date: '2026-07-24', source: 'google_health' });
    expect(rec.activeMinutes).toBe(3);
  });

  it('buckets across the local-midnight boundary (Europe/Berlin, CEST)', () => {
    const acc: ActivityAccumulator = new Map();
    // 2026-07-24T22:30:00Z is 2026-07-25 00:30 local (CEST, +2) → next local day.
    foldActivityPoints(acc, spec('active-zone-minutes'), [
      {
        activeZoneMinutes: {
          interval: { startTime: '2026-07-24T22:30:00Z' },
          activeZoneMinutes: '1',
        },
      },
    ] as unknown as WellnessDataPoint[]);
    expect(accumulatorToRecords(acc)[0]!.date).toBe('2026-07-25');
  });

  it('sets daily resting HR from the live structured-date shape', () => {
    const acc: ActivityAccumulator = new Map();
    // Live shape: daily types carry `date: { year, month, day }` + int64-as-string.
    foldActivityPoints(acc, spec('daily-resting-heart-rate'), [
      {
        dailyRestingHeartRate: {
          date: { year: 2026, month: 7, day: 24 },
          beatsPerMinute: '57',
        },
      },
    ] as unknown as WellnessDataPoint[]);
    const rec = accumulatorToRecords(acc)[0]!;
    expect(rec.restingHr).toBe(57);
    // Cumulative metrics we can't get correctly via List stay null.
    expect(rec.steps).toBeNull();
    expect(rec.distanceKm).toBeNull();
  });

  it('skips points with no resolvable day or value', () => {
    const acc: ActivityAccumulator = new Map();
    foldActivityPoints(acc, spec('active-zone-minutes'), [
      { activeZoneMinutes: { activeZoneMinutes: '1' } }, // no interval/day
      {
        activeZoneMinutes: { interval: { startTime: '2026-07-24T14:49:00Z' } },
      }, // no value
    ] as unknown as WellnessDataPoint[]);
    expect(accumulatorToRecords(acc)).toHaveLength(0);
  });
});

describe('structuredDateToISO', () => {
  it('converts {year,month,day} → zero-padded YYYY-MM-DD', () => {
    expect(structuredDateToISO({ year: 2026, month: 7, day: 4 })).toBe(
      '2026-07-04',
    );
    expect(structuredDateToISO('2026-07-04')).toBeNull();
    expect(structuredDateToISO(null)).toBeNull();
  });
});

describe('mapSleepSession', () => {
  // Real Google Health shape (verified live 2026-08-20): stages is an ARRAY of
  // typed intervals; totals are derived, not summarized. In-bed 04:46–07:38 =
  // 172 min: AWAKE 30 + LIGHT 60 + REM 30 + DEEP 52 (asleep 142).
  const dp = {
    name: 'users/me/dataTypes/sleep/dataPoints/sleep-1',
    sleep: {
      interval: {
        startTime: '2026-08-19T04:46:00Z',
        endTime: '2026-08-19T07:38:00Z',
      },
      type: 'STAGES',
      stages: [
        {
          startTime: '2026-08-19T04:46:00Z',
          endTime: '2026-08-19T05:16:00Z',
          type: 'AWAKE',
        },
        {
          startTime: '2026-08-19T05:16:00Z',
          endTime: '2026-08-19T06:16:00Z',
          type: 'LIGHT',
        },
        {
          startTime: '2026-08-19T06:16:00Z',
          endTime: '2026-08-19T06:46:00Z',
          type: 'REM',
        },
        {
          startTime: '2026-08-19T06:46:00Z',
          endTime: '2026-08-19T07:38:00Z',
          type: 'DEEP',
        },
      ],
    },
  } as unknown as WellnessDataPoint;

  it('derives totals + stage minutes from the stages array', () => {
    const rec = mapSleepSession(dp)!;
    expect(rec).toMatchObject({
      source: 'google_health',
      externalId: 'sleep-1',
      logId: null,
      isMainSleep: null, // not in the payload
      deepMin: 52,
      lightMin: 60,
      remMin: 30,
      wakeMin: 30,
      minutesAsleep: 142, // 60 + 30 + 52
      minutesAwake: 30,
      timeInBed: 172,
      efficiency: 83, // round(142 / 172 * 100)
    });
    // Wake day is the local date of the end instant (Berlin CEST → still Aug 19).
    expect(rec.date).toBe('2026-08-19');
    expect(rec.startAt).toBe('2026-08-19T04:46:00.000Z');
  });

  it('returns null without an id or interval', () => {
    expect(mapSleepSession({ sleep: {} } as WellnessDataPoint)).toBeNull();
    expect(
      mapSleepSession({ name: 'x/dataPoints/id' } as WellnessDataPoint),
    ).toBeNull();
  });
});

describe('mapDailyHrv', () => {
  it('maps avg + deep RMSSD from the live daily-HRV shape', () => {
    // Verified live 2026-07-24: value carries averageHeartRateVariabilityMilliseconds
    // and deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds.
    const dp = {
      dailyHeartRateVariability: {
        date: { year: 2026, month: 8, day: 2 },
        averageHeartRateVariabilityMilliseconds: 137.9,
        deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: 141.2,
      },
    } as unknown as WellnessDataPoint;
    expect(mapDailyHrv(dp)).toEqual({
      date: '2026-08-02',
      source: 'google_health',
      dailyRmssd: 137.9,
      deepRmssd: 141.2,
    });
  });

  it('returns null when the day or value is missing', () => {
    expect(
      mapDailyHrv({
        dailyHeartRateVariability: { date: { year: 2026, month: 8, day: 2 } },
      } as unknown as WellnessDataPoint),
    ).toBeNull();
  });
});

describe('filter builders', () => {
  it('session filter bounds start_time to the local range in UTC', () => {
    // since=2026-07-24 local (CEST, UTC+2) → local midnight is 2026-07-23T22:00:00Z;
    // until exclusive is the next local day → 2026-07-24T22:00:00Z.
    const f = sessionRangeFilter('2026-07-24', '2026-07-25');
    expect(f).toBe(
      'start_time >= "2026-07-23T22:00:00.000Z" AND start_time < "2026-07-24T22:00:00.000Z"',
    );
  });
  it('interval filter uses the snake_case dataType member path', () => {
    const f = intervalRangeFilter(
      'active-zone-minutes',
      '2026-07-24',
      '2026-07-25',
    );
    expect(f).toContain('active_zone_minutes.interval.start_time >=');
    expect(f).not.toContain('activeZoneMinutes');
  });
  it('daily filter compares snake_case `.date` to local YYYY-MM-DD', () => {
    const f = dailyRangeFilter(
      'daily-resting-heart-rate',
      '2026-07-24',
      '2026-07-25',
    );
    expect(f).toBe(
      'daily_resting_heart_rate.date >= "2026-07-24" AND daily_resting_heart_rate.date < "2026-07-25"',
    );
  });
});

describe('civilDateForLocalDay', () => {
  it('nests year/month/day under `date` (no timezone/offset field)', () => {
    expect(civilDateForLocalDay('2026-07-24')).toEqual({
      date: { year: 2026, month: 7, day: 24 },
    });
  });

  it('throws on a malformed local day', () => {
    expect(() => civilDateForLocalDay('2026/07/24')).toThrow();
  });
});

describe('rollupRangeFor', () => {
  it('builds a closed-open CivilDateTime range', () => {
    const range = rollupRangeFor('2026-07-24', '2026-07-25');
    expect(range.start).toEqual({ date: { year: 2026, month: 7, day: 24 } });
    expect(range.end).toEqual({ date: { year: 2026, month: 7, day: 25 } });
  });
});

describe('chunkLocalDayRange', () => {
  it('splits a long range into contiguous, non-overlapping chunks', () => {
    const chunks = chunkLocalDayRange('2026-01-01', '2026-02-01', 14);
    expect(chunks).toEqual([
      { since: '2026-01-01', untilExclusive: '2026-01-15' },
      { since: '2026-01-15', untilExclusive: '2026-01-29' },
      { since: '2026-01-29', untilExclusive: '2026-02-01' },
    ]);
  });

  it('returns a single chunk when the range fits within maxDays', () => {
    expect(chunkLocalDayRange('2026-07-01', '2026-07-10', 90)).toEqual([
      { since: '2026-07-01', untilExclusive: '2026-07-10' },
    ]);
  });

  it('returns no chunks for an empty range', () => {
    expect(chunkLocalDayRange('2026-07-01', '2026-07-01', 14)).toEqual([]);
  });
});

describe('foldRollupPoints', () => {
  it('maps steps (int64-as-string countSum) onto the accumulator', () => {
    const spec = ROLLUP_METRICS.find((s) => s.dataType === 'steps')!;
    const points: RollupDataPoint[] = [
      {
        civilStartTime: { date: { year: 2026, month: 7, day: 24 } },
        steps: { countSum: '8342' },
      } as unknown as RollupDataPoint,
    ];
    const acc: ActivityAccumulator = new Map();
    foldRollupPoints(acc, spec, points);
    expect(acc.get('2026-07-24')).toMatchObject({ steps: 8342 });
  });

  it('scales distance millimeters (int64-as-string) to km', () => {
    const spec = ROLLUP_METRICS.find((s) => s.dataType === 'distance')!;
    const points: RollupDataPoint[] = [
      {
        civilStartTime: { date: { year: 2026, month: 7, day: 24 } },
        distance: { millimetersSum: '9532000' },
      } as unknown as RollupDataPoint,
    ];
    const acc: ActivityAccumulator = new Map();
    foldRollupPoints(acc, spec, points);
    expect(acc.get('2026-07-24')?.distanceKm).toBeCloseTo(9.532, 3);
  });

  it('maps floors and total-calories', () => {
    const floorsSpec = ROLLUP_METRICS.find((s) => s.dataType === 'floors')!;
    const caloriesSpec = ROLLUP_METRICS.find(
      (s) => s.dataType === 'total-calories',
    )!;
    const acc: ActivityAccumulator = new Map();
    foldRollupPoints(acc, floorsSpec, [
      {
        civilStartTime: { date: { year: 2026, month: 7, day: 24 } },
        floors: { floorsSum: 11 },
      } as unknown as RollupDataPoint,
    ]);
    foldRollupPoints(acc, caloriesSpec, [
      {
        civilStartTime: { date: { year: 2026, month: 7, day: 24 } },
        totalCalories: { kcalSum: 2480.5 },
      } as unknown as RollupDataPoint,
    ]);
    expect(acc.get('2026-07-24')).toMatchObject({
      floors: 11,
      caloriesOut: 2480.5,
    });
  });

  it('skips points with no resolvable day or no value', () => {
    const spec = ROLLUP_METRICS.find((s) => s.dataType === 'steps')!;
    const acc: ActivityAccumulator = new Map();
    foldRollupPoints(acc, spec, [
      { steps: { countSum: '100' } } as unknown as RollupDataPoint, // no civilStartTime
      {
        civilStartTime: { date: { year: 2026, month: 7, day: 24 } },
      } as unknown as RollupDataPoint, // no steps value
    ]);
    expect(acc.size).toBe(0);
  });
});

describe('backfillGoogleHealthWellness orchestrator', () => {
  function makeDeps(overrides: Partial<GoogleHealthWellnessDeps> = {}): {
    deps: GoogleHealthWellnessDeps;
    activity: unknown[];
    sleeps: unknown[];
    hrvs: unknown[];
  } {
    const activity: unknown[] = [];
    const sleeps: unknown[] = [];
    const hrvs: unknown[] = [];
    const deps: GoogleHealthWellnessDeps = {
      getAccessToken: async () => 'tok',
      listDataPoints: async (_t, params): Promise<WellnessDataPointList> => {
        if (params.dataType === 'daily-resting-heart-rate') {
          return {
            dataPoints: [
              {
                dailyRestingHeartRate: {
                  date: { year: 2026, month: 7, day: 24 },
                  beatsPerMinute: '57',
                },
              } as unknown as WellnessDataPoint,
            ],
          };
        }
        if (params.dataType === 'sleep') {
          return {
            dataPoints: [
              {
                name: 'users/me/dataTypes/sleep/dataPoints/s1',
                sleep: {
                  interval: {
                    startTime: '2026-07-24T02:00:00Z',
                    endTime: '2026-07-24T09:00:00Z',
                  },
                },
              } as unknown as WellnessDataPoint,
            ],
          };
        }
        if (params.dataType === 'daily-heart-rate-variability') {
          return {
            dataPoints: [
              {
                dailyHeartRateVariability: {
                  date: { year: 2026, month: 7, day: 24 },
                  averageHeartRateVariabilityMilliseconds: 45,
                },
              } as unknown as WellnessDataPoint,
            ],
          };
        }
        return { dataPoints: [] };
      },
      dailyRollUp: async (): Promise<DailyRollUpResponse> => ({
        rollupDataPoints: [],
      }),
      upsertDailyActivity: async (r) => {
        activity.push(r);
      },
      upsertSleepSession: async (r) => {
        sleeps.push(r);
      },
      upsertHrvDaily: async (r) => {
        hrvs.push(r);
      },
      upsertBodyMetric: async () => {},
      ...overrides,
    };
    return { deps, activity, sleeps, hrvs };
  }

  it('runs all three passes and fans out to the writers', async () => {
    const { deps, activity, sleeps, hrvs } = makeDeps();
    const summary = await backfillGoogleHealthWellness(
      { since: '2026-07-24', until: '2026-07-24', pageDelayMs: 0 },
      deps,
    );
    expect(summary).toMatchObject({
      activityDaysUpserted: 1,
      sleepUpserted: 1,
      hrvUpserted: 1,
      rateLimited: false,
    });
    expect(activity).toHaveLength(1);
    expect(sleeps[0]).toMatchObject({ externalId: 's1' });
    expect(hrvs[0]).toMatchObject({ dailyRmssd: 45 });
  });

  it('honors --only by skipping unselected passes', async () => {
    const { deps, activity, sleeps, hrvs } = makeDeps();
    const summary = await backfillGoogleHealthWellness(
      {
        since: '2026-07-24',
        until: '2026-07-24',
        activity: false,
        hrv: false,
        pageDelayMs: 0,
      },
      deps,
    );
    expect(activity).toHaveLength(0);
    expect(hrvs).toHaveLength(0);
    expect(sleeps).toHaveLength(1);
    expect(summary.sleepUpserted).toBe(1);
  });

  it('stops cleanly on a rate limit, returning what it has', async () => {
    const { deps } = makeDeps({
      listDataPoints: async () => {
        throw new GoogleHealthRateLimitError('429');
      },
    });
    const summary = await backfillGoogleHealthWellness(
      { since: '2026-07-24', until: '2026-07-24', pageDelayMs: 0 },
      deps,
    );
    expect(summary.rateLimited).toBe(true);
  });

  it('merges dailyRollUp steps/distance/floors/calories onto the same day record as List-sourced resting HR', async () => {
    const { deps, activity } = makeDeps({
      dailyRollUp: async (_t, params): Promise<DailyRollUpResponse> => {
        const day = { date: { year: 2026, month: 7, day: 24 } };
        if (params.dataType === 'steps') {
          return {
            rollupDataPoints: [
              { civilStartTime: day, steps: { countSum: 9120 } },
            ],
          };
        }
        if (params.dataType === 'distance') {
          return {
            rollupDataPoints: [
              { civilStartTime: day, distance: { millimetersSum: 7_100_000 } },
            ],
          };
        }
        if (params.dataType === 'floors') {
          return {
            rollupDataPoints: [
              { civilStartTime: day, floors: { floorsSum: 9 } },
            ],
          };
        }
        if (params.dataType === 'total-calories') {
          return {
            rollupDataPoints: [
              { civilStartTime: day, totalCalories: { kcalSum: 2390 } },
            ],
          };
        }
        return { rollupDataPoints: [] };
      },
    });
    await backfillGoogleHealthWellness(
      { since: '2026-07-24', until: '2026-07-24', pageDelayMs: 0 },
      deps,
    );
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      date: '2026-07-24',
      steps: 9120,
      floors: 9,
      caloriesOut: 2390,
      restingHr: 57, // still comes from the List-based daily-resting-heart-rate pass
    });
    expect((activity[0] as { distanceKm: number }).distanceKm).toBeCloseTo(
      7.1,
      3,
    );
  });

  it('chunks a long range for total-calories (14-day cap) but not for steps (90-day cap)', async () => {
    const calls: string[] = [];
    const { deps } = makeDeps({
      dailyRollUp: async (_t, params): Promise<DailyRollUpResponse> => {
        calls.push(`${params.dataType}:${params.range.start.date.day}`);
        return { rollupDataPoints: [] };
      },
    });
    // 40-day window: steps (max 90d) → 1 call; total-calories (max 14d) → 3 calls.
    await backfillGoogleHealthWellness(
      { since: '2026-07-01', until: '2026-08-09', pageDelayMs: 0 },
      deps,
    );
    const stepsCalls = calls.filter((c) => c.startsWith('steps:'));
    const caloriesCalls = calls.filter((c) => c.startsWith('total-calories:'));
    expect(stepsCalls).toHaveLength(1);
    expect(caloriesCalls).toHaveLength(3);
  });

  it('propagates a rate limit hit inside dailyRollUp', async () => {
    const { deps } = makeDeps({
      dailyRollUp: async () => {
        throw new GoogleHealthRateLimitError('429');
      },
    });
    const summary = await backfillGoogleHealthWellness(
      { since: '2026-07-24', until: '2026-07-24', pageDelayMs: 0 },
      deps,
    );
    expect(summary.rateLimited).toBe(true);
  });
});
