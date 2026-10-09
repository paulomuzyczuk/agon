import {
  intradayToRunStream,
  summaryToDailyActivity,
  sleepLogToRecord,
  hrvToRecord,
} from '@/services/fitbit/mapper';
import type { FitbitSleepLog } from '@/services/fitbit/types';

describe('intradayToRunStream', () => {
  it('converts intraday samples to offsets from the run start', () => {
    // run starts at 06:00:00 local = 21600s of day
    const start = 6 * 3600;
    const out = intradayToRunStream(start, [
      { time: '06:00:00', value: 120 },
      { time: '06:00:01', value: 130.4 },
      { time: '06:00:30', value: 140 },
    ]);
    expect(out.timeS).toEqual([0, 1, 30]);
    expect(out.heartrate).toEqual([120, 130, 140]); // rounded
  });

  it('drops samples before the run start so offsets stay non-negative', () => {
    const start = 6 * 3600;
    const out = intradayToRunStream(start, [
      { time: '05:59:59', value: 110 }, // before start — dropped
      { time: '06:00:00', value: 120 },
    ]);
    expect(out.timeS).toEqual([0]);
    expect(out.heartrate).toEqual([120]);
  });
});

describe('summaryToDailyActivity', () => {
  it('maps steps, total distance, active minutes, and resting HR', () => {
    const row = summaryToDailyActivity('2026-08-01', {
      steps: 9012,
      floors: 12,
      caloriesOut: 2650,
      sedentaryMinutes: 600,
      lightlyActiveMinutes: 200,
      fairlyActiveMinutes: 30,
      veryActiveMinutes: 45,
      restingHeartRate: 58,
      distances: [
        { activity: 'total', distance: 7.234 },
        { activity: 'Run', distance: 5.0 },
      ],
    });
    expect(row).toMatchObject({
      date: '2026-08-01',
      source: 'fitbit',
      steps: 9012,
      distanceKm: 7.234,
      floors: 12,
      activeMinutes: 75, // fairly + very
      sedentaryMinutes: 600,
      caloriesOut: 2650,
      restingHr: 58,
    });
  });

  it('nulls absent fields rather than inventing zeros', () => {
    const row = summaryToDailyActivity('2026-08-02', { steps: 100 });
    expect(row.steps).toBe(100);
    expect(row.distanceKm).toBeNull();
    expect(row.activeMinutes).toBeNull();
    expect(row.restingHr).toBeNull();
  });
});

function sleepLog(overrides: Partial<FitbitSleepLog> = {}): FitbitSleepLog {
  return {
    logId: 111,
    dateOfSleep: '2026-08-02',
    startTime: '2026-08-01T23:30:00.000',
    endTime: '2026-08-02T07:00:00.000',
    efficiency: 92,
    minutesAsleep: 410,
    minutesAwake: 40,
    timeInBed: 450,
    isMainSleep: true,
    type: 'stages',
    levels: {
      summary: {
        deep: { minutes: 80 },
        light: { minutes: 230 },
        rem: { minutes: 100 },
        wake: { minutes: 40 },
      },
    },
    ...overrides,
  };
}

describe('sleepLogToRecord', () => {
  it('maps stage minutes and converts local start/end to UTC (Europe/Berlin, CEST)', () => {
    const r = sleepLogToRecord(sleepLog(), 'Europe/Berlin');
    expect(r).toMatchObject({
      date: '2026-08-02',
      source: 'fitbit',
      logId: 111,
      startAt: '2026-08-01T21:30:00.000Z', // 23:30 local (CEST, +2) → 21:30Z
      endAt: '2026-08-02T05:00:00.000Z',
      isMainSleep: true,
      minutesAsleep: 410,
      efficiency: 92,
      deepMin: 80,
      lightMin: 230,
      remMin: 100,
      wakeMin: 40,
    });
  });

  it('leaves stage minutes null for a classic (unstaged) log', () => {
    const r = sleepLogToRecord(
      sleepLog({
        type: 'classic',
        levels: {
          summary: { asleep: { minutes: 400 }, awake: { minutes: 20 } },
        },
      }),
      'Europe/Berlin',
    );
    expect(r.deepMin).toBeNull();
    expect(r.remMin).toBeNull();
    expect(r.minutesAsleep).toBe(410); // summary-level fields still map
  });
});

describe('hrvToRecord', () => {
  it('maps daily and deep RMSSD', () => {
    expect(
      hrvToRecord({
        dateTime: '2026-08-02',
        value: { dailyRmssd: 42.5, deepRmssd: 55.1 },
      }),
    ).toEqual({
      date: '2026-08-02',
      source: 'fitbit',
      dailyRmssd: 42.5,
      deepRmssd: 55.1,
    });
  });
});
