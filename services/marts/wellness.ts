import { query } from '@/services/db';
import type {
  WellnessDayPoint,
  WellnessLatest,
  WellnessLatestStat,
} from '@/lib/marts';

// Read side of the wellness / recovery mart for the PWA. The dbt mart
// analytics.fct_wellness_daily is the single source of truth (resting HR, HRV,
// sleep, active minutes on a continuous date spine); this module only shapes rows
// for the API boundary. Numerics are cast to float in SQL (pg returns `numeric`
// as string); the date is rendered as a plain YYYY-MM-DD string (the mart's date
// is a DATE) to avoid timezone drift. Every metric may be null on a given day —
// the three upstream signals are sparse and don't all overlap.

interface Row {
  date: string;
  resting_hr: number | null;
  active_minutes: number | null;
  daily_rmssd: number | null;
  deep_rmssd: number | null;
  minutes_asleep: number | null;
  sleep_efficiency: number | null;
  deep_min: number | null;
  light_min: number | null;
  rem_min: number | null;
  wake_min: number | null;
}

/**
 * Most recent `days` of daily recovery signals, ascending by date. `days` is
 * inclusive of today: the window is (today − days, today].
 */
export async function getWellnessSeries(
  days: number,
): Promise<WellnessDayPoint[]> {
  const { rows } = await query<Row>(
    `
    select
      to_char(date, 'YYYY-MM-DD')  as date,
      resting_hr,
      active_minutes,
      daily_rmssd::float8          as daily_rmssd,
      deep_rmssd::float8           as deep_rmssd,
      minutes_asleep::float8       as minutes_asleep,
      sleep_efficiency::float8     as sleep_efficiency,
      deep_min::float8             as deep_min,
      light_min::float8            as light_min,
      rem_min::float8              as rem_min,
      wake_min::float8             as wake_min
    from analytics.fct_wellness_daily
    where date > current_date - $1::int * interval '1 day'
    order by date asc
    `,
    [days],
  );

  return rows.map((r) => ({
    date: r.date,
    restingHr: r.resting_hr,
    activeMinutes: r.active_minutes,
    hrvRmssd: r.daily_rmssd,
    hrvDeepRmssd: r.deep_rmssd,
    sleepMinutes: r.minutes_asleep,
    sleepEfficiency: r.sleep_efficiency,
    sleepDeepMin: r.deep_min,
    sleepLightMin: r.light_min,
    sleepRemMin: r.rem_min,
    sleepWakeMin: r.wake_min,
  }));
}

/** Walk the (ascending) series backwards for the last non-null reading. */
function lastReading(
  series: WellnessDayPoint[],
  pick: (p: WellnessDayPoint) => number | null,
): WellnessLatestStat | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const p = series[i]!;
    const value = pick(p);
    if (value != null) return { value, date: p.date };
  }
  return null;
}

/**
 * Latest reading per headline metric — computed per metric (not a single "last
 * day"), because the sparse signals rarely land on the same day. Pure: derived
 * from the already-fetched series, no extra DB round-trip.
 */
export function computeWellnessLatest(
  series: WellnessDayPoint[],
): WellnessLatest {
  const sleepMinutes = lastReading(series, (p) => p.sleepMinutes);
  return {
    restingHr: lastReading(series, (p) => p.restingHr),
    hrvRmssd: lastReading(series, (p) => p.hrvRmssd),
    sleepHours:
      sleepMinutes != null
        ? { value: sleepMinutes.value / 60, date: sleepMinutes.date }
        : null,
    sleepEfficiency: lastReading(series, (p) => p.sleepEfficiency),
    activeMinutes: lastReading(series, (p) => p.activeMinutes),
  };
}
