import { hmsToSecondsOfDay, athleteLocalToUtcISO } from '../../lib/time';
import type { RunStreamData } from '../runStreams';
import type { DailyActivityRecord } from '../dailyActivity';
import type { SleepSessionRecord, HrvDailyRecord } from '../wellness';
import type { IntradayHrSample } from './client';
import type { FitbitDailySummary, FitbitSleepLog, FitbitHrv } from './types';

// Pure mappings from Fitbit payloads to our storage shapes. No I/O.

/**
 * Build a run's HR stream from a Fitbit intraday dataset. `time_s` is each
 * sample's offset from the run's local start; samples are already within the
 * queried window, but any that precede the start (clock rounding) are dropped so
 * time_s stays non-negative and monotonic.
 */
export function intradayToRunStream(
  runLocalStartSecondsOfDay: number,
  dataset: IntradayHrSample[],
): RunStreamData {
  const timeS: number[] = [];
  const heartrate: number[] = [];
  for (const sample of dataset) {
    const offset = hmsToSecondsOfDay(sample.time) - runLocalStartSecondsOfDay;
    if (offset < 0) continue;
    timeS.push(offset);
    heartrate.push(Math.round(sample.value));
  }
  return { timeS, heartrate };
}

const round = (n: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** Map a Fitbit daily summary to a daily_activity row. */
export function summaryToDailyActivity(
  date: string,
  summary: FitbitDailySummary['summary'],
): DailyActivityRecord {
  const total = summary.distances?.find((d) => d.activity === 'total');
  const active =
    summary.fairlyActiveMinutes != null || summary.veryActiveMinutes != null
      ? (summary.fairlyActiveMinutes ?? 0) + (summary.veryActiveMinutes ?? 0)
      : null;
  return {
    date,
    source: 'fitbit',
    steps: summary.steps ?? null,
    distanceKm: total ? round(total.distance, 3) : null,
    floors: summary.floors ?? null,
    activeMinutes: active,
    sedentaryMinutes: summary.sedentaryMinutes ?? null,
    caloriesOut: summary.caloriesOut ?? null,
    restingHr: summary.restingHeartRate ?? null,
  };
}

/** Map a Fitbit sleep log to a sleep_sessions row (local times → UTC instants). */
export function sleepLogToRecord(
  log: FitbitSleepLog,
  timeZone: string,
): SleepSessionRecord {
  const stage = (name: string): number | null =>
    log.levels?.summary?.[name]?.minutes ?? null;
  return {
    date: log.dateOfSleep,
    source: 'fitbit',
    // Unified idempotency key (source, external_id): Fitbit mirrors its numeric
    // log id as text so every sleep row keys the same way as Google Health's
    // string session ids (migration 20260724014000).
    externalId: String(log.logId),
    logId: log.logId,
    startAt: athleteLocalToUtcISO(log.startTime, timeZone),
    endAt: athleteLocalToUtcISO(log.endTime, timeZone),
    isMainSleep: log.isMainSleep ?? null,
    minutesAsleep: log.minutesAsleep ?? null,
    minutesAwake: log.minutesAwake ?? null,
    timeInBed: log.timeInBed ?? null,
    efficiency: log.efficiency ?? null,
    // Stage minutes exist only on "stages" logs; "classic" logs return null.
    deepMin: stage('deep'),
    lightMin: stage('light'),
    remMin: stage('rem'),
    wakeMin: stage('wake'),
  };
}

/** Map a Fitbit HRV entry to an hrv_daily row. */
export function hrvToRecord(entry: FitbitHrv['hrv'][number]): HrvDailyRecord {
  return {
    date: entry.dateTime,
    source: 'fitbit',
    dailyRmssd: entry.value.dailyRmssd ?? null,
    deepRmssd: entry.value.deepRmssd ?? null,
  };
}
