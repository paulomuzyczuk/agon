import { query } from '@/services/db';
import { getAthleteProfile } from '@/lib/athleteProfile';
import type {
  BodyCompPoint,
  BodyCompLatest,
  BodyCompLatestStat,
} from '@/lib/marts';

// Read side of the body-composition mart for the PWA. analytics.fct_body_comp_trend
// is the single source of truth (weight_kg + body_fat_pct on a continuous date
// spine); this module only shapes rows for the API boundary. Numerics are cast to
// float in SQL (pg returns `numeric` as string); the date is rendered as a plain
// YYYY-MM-DD string (the mart's date is a DATE) to avoid timezone drift. Weigh-ins
// are sparse — either field may be null on a given day.

interface Row {
  date: string;
  weight_kg: number | null;
  body_fat_pct: number | null;
}

/**
 * Full body-composition history, ascending by date. Unlike the wellness/
 * training-load views there is no `?days=` window — weigh-ins are so sparse
 * (roughly monthly) that a 60-day window would often show only 1-2 points; the
 * whole trend is the useful unit here.
 */
export async function getBodyCompSeries(): Promise<BodyCompPoint[]> {
  const { rows } = await query<Row>(
    `
    select
      to_char(date, 'YYYY-MM-DD')  as date,
      weight_kg::float8            as weight_kg,
      body_fat_pct::float8         as body_fat_pct
    from analytics.fct_body_comp_trend
    order by date asc
    `,
  );

  return rows.map((r) => ({
    date: r.date,
    weightKg: r.weight_kg,
    bodyFatPct: r.body_fat_pct,
  }));
}

/** Walk the (ascending) series backwards for the last non-null reading. */
function lastReading(
  series: BodyCompPoint[],
  pick: (p: BodyCompPoint) => number | null,
): BodyCompLatestStat | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const p = series[i]!;
    const value = pick(p);
    if (value != null) return { value, date: p.date };
  }
  return null;
}

/**
 * Latest reading per metric — computed per metric (not a single "last day"),
 * since weight and BF% are often logged on different days. Pure: derived from
 * the already-fetched series, no extra DB round-trip.
 */
export function computeBodyCompLatest(series: BodyCompPoint[]): BodyCompLatest {
  return {
    weightKg: lastReading(series, (p) => p.weightKg),
    bodyFatPct: lastReading(series, (p) => p.bodyFatPct),
  };
}

/** Starting figures from the Athlete Profile — a fixed reference, not a query. */
export function getBodyCompStarting(): {
  startingWeightKg: number;
  startingBodyFatPct: number;
} {
  const profile = getAthleteProfile();
  return {
    startingWeightKg: profile.startingWeightKg,
    startingBodyFatPct: profile.startingBodyFatPct,
  };
}
