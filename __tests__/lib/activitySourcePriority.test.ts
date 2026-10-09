import {
  partitionOverlaps,
  sourceTier,
  SUPERSEDE_MAX_START_DELTA_MS,
} from '@/lib/activitySourcePriority';

const T0 = Date.parse('2026-09-26T16:49:08Z');

describe('sourceTier', () => {
  it('ranks Agon > Strava/exports > Google Health', () => {
    expect(sourceTier('live_recording')).toBe(1);
    expect(sourceTier('manual')).toBe(1);
    expect(sourceTier('telegram')).toBe(1);
    expect(sourceTier('strava')).toBe(2);
    expect(sourceTier('strava_export')).toBe(2);
    expect(sourceTier('garmin_export')).toBe(2);
    expect(sourceTier('samsung_export')).toBe(2);
    expect(sourceTier('google_health')).toBe(3);
  });

  it('treats an unknown source as a device export', () => {
    expect(sourceTier('coros')).toBe(2);
  });
});

describe('partitionOverlaps', () => {
  it('supersedes a lower-priority twin (the 26 Sep strava vs google_health case)', () => {
    const gh = { id: 'gh', source: 'google_health', startedAtMs: T0 - 40_000 };
    const p = partitionOverlaps({ source: 'strava', startedAtMs: T0 }, [gh]);
    expect(p).toEqual({ blocking: [], supersede: [gh], ambiguous: [] });
  });

  it('is blocked by a higher-priority twin', () => {
    const live = { id: 'lr', source: 'live_recording', startedAtMs: T0 };
    const p = partitionOverlaps({ source: 'strava', startedAtMs: T0 }, [live]);
    expect(p.blocking).toEqual([live]);
    expect(p.supersede).toEqual([]);
  });

  it('is blocked by an equal-priority twin (first stored wins)', () => {
    const exp = { id: 'ge', source: 'garmin_export', startedAtMs: T0 };
    const p = partitionOverlaps({ source: 'strava', startedAtMs: T0 }, [exp]);
    expect(p.blocking).toEqual([exp]);
  });

  it('Google Health never supersedes anything', () => {
    const s = { id: 's', source: 'strava', startedAtMs: T0 };
    const p = partitionOverlaps({ source: 'google_health', startedAtMs: T0 }, [
      s,
    ]);
    expect(p.blocking).toEqual([s]);
  });

  it('holds back a lower-priority overlap that starts too far apart', () => {
    const far = {
      id: 'gh',
      source: 'google_health',
      startedAtMs: T0 + SUPERSEDE_MAX_START_DELTA_MS + 1,
    };
    const p = partitionOverlaps({ source: 'strava', startedAtMs: T0 }, [far]);
    expect(p).toEqual({ blocking: [], supersede: [], ambiguous: [far] });
  });

  it('orders blockers best-first', () => {
    const exp = { id: 'e', source: 'garmin_export', startedAtMs: T0 };
    const man = { id: 'm', source: 'manual', startedAtMs: T0 + 5 };
    const p = partitionOverlaps({ source: 'strava', startedAtMs: T0 }, [
      exp,
      man,
    ]);
    expect(p.blocking.map((b) => b.id)).toEqual(['m', 'e']);
  });
});
