import {
  summarizeFreshness,
  tableFromUniqueId,
  type FreshnessArtifact,
} from '@/lib/dataFreshness';

// The escalation rules of the ingestion dead-man's switch, against fixtures
// shaped like dbt's target/sources.json. Pure — no dbt, no DB.

const HOUR = 3600;

function artifact(...rows: [string, string, number?][]): FreshnessArtifact {
  return {
    results: rows.map(([table, status, ageS]) => ({
      unique_id: `source.agon_analytics.agon_raw.${table}`,
      status: status as never,
      ...(ageS === undefined ? {} : { max_loaded_at_time_ago_in_s: ageS }),
    })),
  };
}

describe('tableFromUniqueId', () => {
  it('takes the table off dbt’s fully-qualified id', () => {
    expect(tableFromUniqueId('source.agon_analytics.agon_raw.runs')).toBe(
      'runs',
    );
  });
});

describe('summarizeFreshness', () => {
  it('says nothing when every source is fresh', () => {
    const r = summarizeFreshness(
      artifact(['runs', 'pass', HOUR], ['daily_activity', 'pass', HOUR]),
    );
    expect(r.message).toBeNull();
    expect(r.failed).toBe(false);
    expect(r.stale).toEqual([]);
    expect(r.checked).toBe(2);
  });

  it('reports a warn without failing the run', () => {
    const r = summarizeFreshness(
      artifact(['runs', 'pass', HOUR], ['hrv_daily', 'warn', 200 * HOUR]),
    );
    expect(r.failed).toBe(false);
    expect(r.message).toContain('going stale');
    expect(r.message).toContain('hrv_daily — 200h old');
  });

  it('fails on an error and names the pipeline to fix', () => {
    const r = summarizeFreshness(artifact(['runs', 'error', 300 * HOUR]));
    expect(r.failed).toBe(true);
    expect(r.message).toContain('a pipeline has stopped');
    // The alert is useless if it doesn't say what to go and restart.
    expect(r.message).toContain('run ingestion (gh:sync / strava:enrich)');
  });

  it('leads with the worst status so a truncated alert still shows it', () => {
    const r = summarizeFreshness(
      artifact(
        ['hrv_daily', 'warn', 200 * HOUR],
        ['runs', 'error', 300 * HOUR],
        ['sleep_sessions', 'warn', 100 * HOUR],
      ),
    );
    expect(r.stale.map((s) => s.table)).toEqual([
      'runs',
      'hrv_daily',
      'sleep_sessions',
    ]);
  });

  it('treats a check that could not run as a failure, not as a pass', () => {
    // "Unknown" must never read as "fine" — that is how the switch dies quietly.
    const r = summarizeFreshness(artifact(['runs', 'runtime error']));
    expect(r.failed).toBe(true);
    expect(r.stale[0]!.ageHours).toBeNull();
    expect(r.message).toContain('unknown age');
  });

  it('reproduces the August 2026 gap it was built to catch', () => {
    // 2026-08-04 → 2026-08-20: no run reached the database and nothing said so.
    // 16 days is well past the 168h error threshold.
    const r = summarizeFreshness(
      artifact(
        ['runs', 'error', 16 * 24 * HOUR],
        ['daily_activity', 'error', 16 * 24 * HOUR],
      ),
    );
    expect(r.failed).toBe(true);
    expect(r.message).toContain('runs — 384h old');
    expect(r.message).toContain('2 of 2 source(s) flagged');
  });
});
