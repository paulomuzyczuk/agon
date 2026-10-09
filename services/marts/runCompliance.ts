import { query } from '@/services/db';
import type { RunComplianceWeek } from '@/lib/marts';

// Read side of the weekly run-compliance mart for the PWA. The dbt mart
// analytics.fct_run_compliance_weekly is the single source of truth (actual
// vs. planned km, easy-run HR-cap adherence); this module only shapes rows
// for the API boundary. Numerics are cast to float in SQL (pg returns
// `numeric` as string).

interface Row {
  block: number;
  week: number;
  block_week: string;
  actual_km: number | null;
  target_km: number | null;
  km_compliance_pct: number | null;
  easy_runs_capped: number | null;
  easy_runs_compliant: number | null;
  hr_compliance_pct: number | null;
}

/** All weeks, block/week ascending. */
export async function getRunComplianceWeeks(): Promise<RunComplianceWeek[]> {
  const { rows } = await query<Row>(
    `
    select
      block,
      week,
      block_week,
      actual_km::float8            as actual_km,
      target_km::float8            as target_km,
      km_compliance_pct::float8    as km_compliance_pct,
      easy_runs_capped::int,
      easy_runs_compliant::int,
      hr_compliance_pct::float8    as hr_compliance_pct
    from analytics.fct_run_compliance_weekly
    order by block, week
    `,
  );

  return rows.map((r) => ({
    block: r.block,
    week: r.week,
    blockWeek: r.block_week,
    actualKm: r.actual_km,
    targetKm: r.target_km,
    kmCompliancePct: r.km_compliance_pct,
    easyRunsCapped: r.easy_runs_capped,
    easyRunsCompliant: r.easy_runs_compliant,
    hrCompliancePct: r.hr_compliance_pct,
  }));
}
