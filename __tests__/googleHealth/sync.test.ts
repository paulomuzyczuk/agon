import {
  startTimeAfterFromWatermark,
  syncNewGoogleHealthRuns,
  describeGoogleHealthSyncSummary,
  type GoogleHealthSyncSummary,
} from '@/services/googleHealth/sync';
import type {
  GoogleHealthBackfillOptions,
  GoogleHealthBackfillSummary,
} from '@/services/googleHealth/ingest';

// Unit lane — no DB, no network. The DB watermark query (getGoogleHealthWatermark)
// is exercised in the integration lane; here both seams are injected so we can pin
// the watermark→`start_time` derivation and the summary shaping.

function emptySummary(
  over: Partial<GoogleHealthBackfillSummary> = {},
): GoogleHealthBackfillSummary {
  return {
    pagesFetched: 1,
    sessionsSeen: 0,
    runsInserted: 0,
    runsUpdated: 0,
    skippedNonRun: 0,
    runsDeduped: 0,
    runsSkippedExisting: 0,
    streamsFetched: 0,
    hrStreamsFetched: 0,
    rateLimited: false,
    ...over,
  };
}

describe('startTimeAfterFromWatermark', () => {
  it('returns undefined for a null watermark (full pull)', () => {
    expect(startTimeAfterFromWatermark(null)).toBeUndefined();
  });
  it('emits the watermark as an RFC-3339 instant', () => {
    const d = new Date('2026-07-24T12:00:00.000Z');
    expect(startTimeAfterFromWatermark(d)).toBe('2026-07-24T12:00:00.000Z');
  });
});

describe('syncNewGoogleHealthRuns', () => {
  it('passes the watermark instant as start_time filter and defaults streams on', async () => {
    let seen: GoogleHealthBackfillOptions | undefined;
    const watermark = new Date('2026-07-20T09:30:00.000Z');
    const result = await syncNewGoogleHealthRuns(
      {},
      {
        getWatermark: async () => watermark,
        runIncremental: async (opts) => {
          seen = opts;
          return emptySummary({ runsInserted: 2, sessionsSeen: 3 });
        },
      },
    );

    expect(seen?.startTimeAfter).toBe('2026-07-20T09:30:00.000Z');
    expect(seen?.withStreams).toBe(true);
    expect(result.since).toBe('2026-07-20T09:30:00.000Z');
    expect(result.runsInserted).toBe(2);
  });

  it('does a full pull (start_time undefined, since null) when there is no watermark', async () => {
    let seen: GoogleHealthBackfillOptions | undefined;
    const result = await syncNewGoogleHealthRuns(
      {},
      {
        getWatermark: async () => null,
        runIncremental: async (opts) => {
          seen = opts;
          return emptySummary();
        },
      },
    );
    expect(seen?.startTimeAfter).toBeUndefined();
    expect(result.since).toBeNull();
  });

  it('honors withStreams=false', async () => {
    let seen: GoogleHealthBackfillOptions | undefined;
    await syncNewGoogleHealthRuns(
      { withStreams: false },
      {
        getWatermark: async () => null,
        runIncremental: async (opts) => {
          seen = opts;
          return emptySummary();
        },
      },
    );
    expect(seen?.withStreams).toBe(false);
  });

  it('surfaces a rate-limited pass without throwing', async () => {
    const result = await syncNewGoogleHealthRuns(
      {},
      {
        getWatermark: async () => null,
        runIncremental: async () =>
          emptySummary({ runsInserted: 1, rateLimited: true }),
      },
    );
    expect(result.rateLimited).toBe(true);
    expect(result.runsInserted).toBe(1);
  });
});

describe('describeGoogleHealthSyncSummary', () => {
  const base: GoogleHealthSyncSummary = { ...emptySummary(), since: null };

  it('pluralizes and reports the new run count', () => {
    expect(describeGoogleHealthSyncSummary({ ...base, runsInserted: 0 })).toBe(
      'Pulled 0 new runs.',
    );
    expect(describeGoogleHealthSyncSummary({ ...base, runsInserted: 1 })).toBe(
      'Pulled 1 new run.',
    );
  });

  it('flags a rate-limited pass so the user knows to resume', () => {
    const msg = describeGoogleHealthSyncSummary({
      ...base,
      runsInserted: 2,
      rateLimited: true,
    });
    expect(msg).toMatch(/Pulled 2 new runs/);
    expect(msg).toMatch(/rate limit/);
  });
});
