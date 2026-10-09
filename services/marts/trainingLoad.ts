import { query } from '@/services/db';
import type { FormZone, TrainingLoadPoint } from '@/lib/marts';

// Read side of the training-load mart for the PWA. The dbt mart
// analytics.fct_training_load_daily is the single source of truth (Banister
// CTL/ATL/TSB); this module only shapes rows for the API boundary. No business
// logic here — the math lives in lib/trainingLoad.ts and the mart.

interface Row {
  date: string;
  daily_load: number;
  ctl: number;
  atl: number;
  tsb: number;
  ctl_delta: number | null;
  form_zone: FormZone;
}

/**
 * Most recent `days` of the Fitness/Fatigue/Form curve, ascending by date.
 * Numerics are cast to float in SQL (pg returns `numeric` as string otherwise),
 * and the date is rendered as a plain `YYYY-MM-DD` string to avoid any timezone
 * drift across the API boundary.
 */
export async function getTrainingLoadSeries(
  days: number,
): Promise<TrainingLoadPoint[]> {
  const { rows } = await query<Row>(
    `
    select
      to_char(date, 'YYYY-MM-DD')       as date,
      daily_load::float8                as daily_load,
      ctl::float8                       as ctl,
      atl::float8                       as atl,
      tsb::float8                       as tsb,
      ctl_delta::float8                 as ctl_delta,
      form_zone
    from analytics.fct_training_load_daily
    -- Most recent N calendar days, inclusive of today: (today − N, today].
    where date > current_date - $1::int * interval '1 day'
    order by date asc
    `,
    [days],
  );

  return rows.map((r) => ({
    date: r.date,
    dailyLoad: r.daily_load,
    ctl: r.ctl,
    atl: r.atl,
    tsb: r.tsb,
    ctlDelta: r.ctl_delta,
    formZone: r.form_zone,
  }));
}
