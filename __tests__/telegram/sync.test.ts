import { executeCommand } from '@/services/telegram/handlers';
import type { GoogleHealthSyncSummary } from '@/services/googleHealth/sync';

// Unit lane — the `/sync` command path only touches the injected sync function
// (no DB), so it's fully unit-testable. The real network-backed sync is covered
// by the googleHealth/sync unit + integration lanes.

function summary(
  over: Partial<GoogleHealthSyncSummary> = {},
): GoogleHealthSyncSummary {
  return {
    pagesFetched: 1,
    sessionsSeen: 1,
    runsInserted: 1,
    runsUpdated: 0,
    skippedNonRun: 0,
    runsDeduped: 0,
    runsSkippedExisting: 0,
    streamsFetched: 1,
    hrStreamsFetched: 1,
    rateLimited: false,
    since: null,
    ...over,
  };
}

describe('executeCommand /sync', () => {
  it('runs the injected sync and reports the new run count', async () => {
    const reply = await executeCommand(
      { kind: 'sync' },
      {
        today: '2026-07-24',
        syncRuns: async () => summary({ runsInserted: 2 }),
      },
    );
    expect(reply).toBe('🔄 Pulled 2 new runs.');
  });

  it('replies with a friendly error when the sync throws', async () => {
    const reply = await executeCommand(
      { kind: 'sync' },
      {
        today: '2026-07-24',
        syncRuns: async () => {
          throw new Error('no tokens');
        },
      },
    );
    expect(reply).toMatch(/Run sync failed/);
  });
});
