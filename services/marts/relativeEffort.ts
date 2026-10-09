import { query } from '@/services/db';
import type { RelativeEffortMethod, RelativeEffortRun } from '@/lib/marts';

// Read side of the per-run Relative Effort mart for the PWA. The dbt mart
// analytics.fct_relative_effort is the single source of truth (Banister TRIMP per
// activity); this module only shapes rows for the API boundary. No business logic
// here — the math lives in lib/relativeEffort.ts and the mart. Numerics are cast
// to float in SQL (pg returns `numeric` as string); the date is rendered as a
// plain YYYY-MM-DD string (runs.date is a DATE) to avoid timezone drift.

interface Row {
  run_id: string;
  date: string;
  block: number | null;
  week: number | null;
  distance_km: number | null;
  duration_s: number | null;
  relative_effort: number;
  relative_effort_per_hour: number | null;
  method: RelativeEffortMethod;
  stream_source: string | null;
}

/**
 * Most recent `limit` scored runs, most-recent first. Ordered by date desc, then
 * relative_effort desc as a stable tiebreak for two runs on the same day.
 */
export async function getRelativeEffortRuns(
  limit: number,
): Promise<RelativeEffortRun[]> {
  const { rows } = await query<Row>(
    `
    select
      run_id::text                       as run_id,
      to_char(date, 'YYYY-MM-DD')        as date,
      block,
      week,
      distance_km::float8                as distance_km,
      duration_s,
      relative_effort::float8            as relative_effort,
      relative_effort_per_hour::float8   as relative_effort_per_hour,
      method,
      stream_source
    from analytics.fct_relative_effort
    order by date desc, relative_effort desc
    limit $1::int
    `,
    [limit],
  );

  return rows.map((r) => ({
    runId: r.run_id,
    date: r.date,
    block: r.block,
    week: r.week,
    distanceKm: r.distance_km,
    durationS: r.duration_s,
    relativeEffort: r.relative_effort,
    relativeEffortPerHour: r.relative_effort_per_hour,
    method: r.method,
    streamSource: r.stream_source,
  }));
}
