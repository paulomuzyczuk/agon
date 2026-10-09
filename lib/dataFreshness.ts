// Turning a dbt `source freshness` run into something a human is told about.
//
// dbt writes target/sources.json and exits; on its own that is a file nobody
// reads, which is how the 2026-08 ingestion gap survived eight days. This module
// is the pure half of the dead-man's switch: read the artifact, decide whether it
// is worth waking someone for, and phrase it so the message names the pipeline to
// go and fix.
//
// Pure (no DB, no network, no Date.now) so the escalation rules are unit-tested
// against fixtures rather than by waiting for a real outage.

export type FreshnessStatus = 'pass' | 'warn' | 'error' | 'runtime error';

/** One entry of dbt's sources.json `results` array (the fields we rely on). */
export interface FreshnessResult {
  unique_id: string;
  status: FreshnessStatus;
  max_loaded_at?: string;
  max_loaded_at_time_ago_in_s?: number;
}

export interface FreshnessArtifact {
  results: FreshnessResult[];
}

export interface StaleSource {
  /** Table name alone ("runs"), not dbt's fully-qualified unique_id. */
  table: string;
  status: FreshnessStatus;
  /** Whole hours since the newest row arrived, or null when dbt couldn't tell. */
  ageHours: number | null;
}

export interface FreshnessReport {
  /** Sources needing attention, worst first. */
  stale: StaleSource[];
  /** How many sources were checked in total. */
  checked: number;
  /** True when anything is error-level — the caller should exit non-zero. */
  failed: boolean;
  /** Null when everything passed; otherwise the message to send. */
  message: string | null;
}

/** dbt's unique_id is "source.<project>.<source>.<table>"; we want the table. */
export function tableFromUniqueId(uniqueId: string): string {
  const parts = uniqueId.split('.');
  return parts[parts.length - 1] ?? uniqueId;
}

// Worst first, so a truncated notification still leads with the real problem.
const SEVERITY: Record<FreshnessStatus, number> = {
  error: 0,
  'runtime error': 1,
  warn: 2,
  pass: 3,
};

/** What each table going stale actually means, so the alert names the fix. */
const MEANING: Record<string, string> = {
  runs: 'run ingestion (gh:sync / strava:enrich)',
  daily_activity: 'wellness ingestion (gh:wellness)',
  sleep_sessions: 'sleep ingestion (gh:wellness)',
  hrv_daily: 'HRV ingestion (gh:wellness)',
  run_relative_effort: 'Relative Effort backfill (re:backfill)',
  training_load_daily: 'training-load backfill (tl:backfill)',
};

function describe(s: StaleSource): string {
  const meaning = MEANING[s.table];
  const age = s.ageHours === null ? 'unknown age' : `${s.ageHours}h old`;
  const label = s.status === 'error' ? '🔴' : '🟠';
  return `${label} ${s.table} — ${age}${meaning ? ` · ${meaning}` : ''}`;
}

/**
 * Reduce a freshness run to a report. A 'runtime error' counts as a FAILURE
 * rather than being skipped: a check that could not run tells you nothing about
 * the pipeline, and silently treating "unknown" as "fine" is precisely how a
 * dead-man's switch stops being one.
 */
export function summarizeFreshness(
  artifact: FreshnessArtifact,
): FreshnessReport {
  const stale = artifact.results
    .filter((r) => r.status !== 'pass')
    .map((r) => ({
      table: tableFromUniqueId(r.unique_id),
      status: r.status,
      ageHours:
        typeof r.max_loaded_at_time_ago_in_s === 'number'
          ? Math.floor(r.max_loaded_at_time_ago_in_s / 3600)
          : null,
    }))
    .sort(
      (a, b) =>
        SEVERITY[a.status] - SEVERITY[b.status] ||
        a.table.localeCompare(b.table),
    );

  const failed = stale.some(
    (s) => s.status === 'error' || s.status === 'runtime error',
  );
  const checked = artifact.results.length;

  if (stale.length === 0) {
    return { stale, checked, failed: false, message: null };
  }

  const head = failed
    ? '🔴 Agon data freshness: a pipeline has stopped'
    : '🟠 Agon data freshness: something is going stale';
  const message = [
    head,
    ...stale.map(describe),
    `(${stale.length} of ${checked} source(s) flagged)`,
  ].join('\n');

  return { stale, checked, failed, message };
}
