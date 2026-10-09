import {
  afterEpochFromWatermark,
  syncNewStravaRuns,
  describeSyncSummary,
  type StravaSyncSummary,
} from '@/services/strava/sync';
import type {
  BackfillOptions,
  BackfillSummary,
} from '@/services/strava/ingest';

// Unit lane — no DB, no network. The DB watermark query (getStravaWatermark) is
// exercised in the integration lane; here both seams are injected so we can pin
// the watermark→`after` derivation and the summary shaping.

function emptySummary(over: Partial<BackfillSummary> = {}): BackfillSummary {
  return {
    pagesFetched: 1,
    activitiesSeen: 0,
    runsInserted: 0,
    runsUpdated: 0,
    skippedNonRun: 0,
    runsSkippedExisting: 0,
    runsSuperseded: 0,
    streamsFetched: 0,
    rateLimited: false,
    ...over,
  };
}

describe('afterEpochFromWatermark', () => {
  it('returns undefined for a null watermark (full pull)', () => {
    expect(afterEpochFromWatermark(null)).toBeUndefined();
  });

  it('floors a Date to epoch seconds', () => {
    // Sub-second precision is dropped: the .500 ms floors away.
    const d = new Date('2026-07-24T12:00:00.500Z');
    expect(afterEpochFromWatermark(d)).toBe(Math.floor(d.getTime() / 1000));
    const dRounded = new Date('2026-07-24T12:00:00.000Z');
    expect(afterEpochFromWatermark(d)).toBe(dRounded.getTime() / 1000);
  });
});

describe('syncNewStravaRuns', () => {
  it('passes the watermark epoch as `after` and defaults to streams+gear on', async () => {
    let seen: BackfillOptions | undefined;
    const watermark = new Date('2026-07-20T09:30:00.000Z');
    const result = await syncNewStravaRuns(
      {},
      {
        getWatermark: async () => watermark,
        runIncremental: async (opts) => {
          seen = opts;
          return emptySummary({ runsInserted: 2, activitiesSeen: 3 });
        },
      },
    );

    expect(seen?.after).toBe(Math.floor(watermark.getTime() / 1000));
    expect(seen?.withStreams).toBe(true);
    expect(seen?.resolveGear).toBe(true);
    expect(result.since).toBe(Math.floor(watermark.getTime() / 1000));
    expect(result.runsInserted).toBe(2);
  });

  it('does a full pull (after undefined, since null) when there is no watermark', async () => {
    let seen: BackfillOptions | undefined;
    const result = await syncNewStravaRuns(
      {},
      {
        getWatermark: async () => null,
        runIncremental: async (opts) => {
          seen = opts;
          return emptySummary();
        },
      },
    );

    expect(seen?.after).toBeUndefined();
    expect(result.since).toBeNull();
  });

  it('honors withStreams=false', async () => {
    let seen: BackfillOptions | undefined;
    await syncNewStravaRuns(
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
    const result = await syncNewStravaRuns(
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

describe('describeSyncSummary', () => {
  const base: StravaSyncSummary = { ...emptySummary(), since: 100 };

  it('pluralizes and reports the new run count', () => {
    expect(describeSyncSummary({ ...base, runsInserted: 0 })).toBe(
      'Pulled 0 new runs.',
    );
    expect(describeSyncSummary({ ...base, runsInserted: 1 })).toBe(
      'Pulled 1 new run.',
    );
    expect(describeSyncSummary({ ...base, runsInserted: 3 })).toBe(
      'Pulled 3 new runs.',
    );
  });

  it('flags a rate-limited pass so the user knows to resume', () => {
    const msg = describeSyncSummary({
      ...base,
      runsInserted: 2,
      rateLimited: true,
    });
    expect(msg).toMatch(/Pulled 2 new runs/);
    expect(msg).toMatch(/rate limit/);
  });
});
