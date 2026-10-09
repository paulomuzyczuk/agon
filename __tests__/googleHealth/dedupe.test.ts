import { dedupeRuns, sessionInterval } from '@/services/googleHealth/dedupe';
import type { ExerciseDataPoint } from '@/services/googleHealth/types';

// Pure dedupe logic — no DB/network. Mirrors the real Google Health shape: a run
// often appears twice (a HEALTH_CONNECT phone/SOT record + a FITBIT auto-detect),
// and we keep the SOT-accurate one.

let seq = 0;
function dp(o: {
  start: string;
  durS?: number;
  end?: string;
  platform?: string;
  recording?: string;
  distMm?: number;
}): ExerciseDataPoint {
  seq += 1;
  return {
    name: `users/me/dataTypes/exercise/dataPoints/dp-${seq}`,
    dataSource: { platform: o.platform, recordingMethod: o.recording },
    exercise: {
      interval: { startTime: o.start, endTime: o.end },
      exerciseType: 'RUNNING',
      activeDuration: o.durS != null ? `${o.durS}s` : undefined,
      metricsSummary: { distanceMillimeters: o.distMm ?? 10_000_000 },
    },
  };
}

describe('sessionInterval', () => {
  it('uses activeDuration for the end when present', () => {
    const iv = sessionInterval(
      dp({ start: '2026-07-23T18:00:00Z', durS: 3600 }),
    )!;
    expect(iv.endMs - iv.startMs).toBe(3600_000);
  });
  it('falls back to interval.endTime', () => {
    const iv = sessionInterval(
      dp({ start: '2026-07-23T18:00:00Z', end: '2026-07-23T18:30:00Z' }),
    )!;
    expect(iv.endMs - iv.startMs).toBe(1800_000);
  });
  it('is null when neither duration nor end resolves', () => {
    expect(sessionInterval(dp({ start: '2026-07-23T18:00:00Z' }))).toBeNull();
  });
});

describe('dedupeRuns', () => {
  it('keeps the HEALTH_CONNECT record over an overlapping FITBIT twin', () => {
    const hc = dp({
      start: '2026-07-23T18:00:00Z',
      durS: 3000,
      platform: 'HEALTH_CONNECT',
      recording: 'ACTIVELY_MEASURED',
    });
    const fitbit = dp({
      start: '2026-07-23T18:00:20Z', // overlaps (Fitbit detected 20s later)
      durS: 3300,
      platform: 'FITBIT',
      recording: 'PASSIVELY_MEASURED',
    });
    const { canonical, dropped } = dedupeRuns([fitbit, hc]); // order-independent
    expect(dropped).toBe(1);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.dataSource!.platform).toBe('HEALTH_CONNECT');
  });

  it('keeps two genuinely separate runs on the same day', () => {
    const morning = dp({ start: '2026-07-23T06:00:00Z', durS: 1800 });
    const evening = dp({ start: '2026-07-23T18:00:00Z', durS: 1800 });
    const { canonical, dropped } = dedupeRuns([morning, evening]);
    expect(dropped).toBe(0);
    expect(canonical).toHaveLength(2);
  });

  it('prefers actively-measured, then longer distance, within one platform', () => {
    const passive = dp({
      start: '2026-07-23T18:00:00Z',
      durS: 3000,
      platform: 'FITBIT',
      recording: 'PASSIVELY_MEASURED',
      distMm: 9_000_000,
    });
    const active = dp({
      start: '2026-07-23T18:01:00Z',
      durS: 3000,
      platform: 'FITBIT',
      recording: 'ACTIVELY_MEASURED',
      distMm: 8_000_000,
    });
    const { canonical } = dedupeRuns([passive, active]);
    expect(canonical[0]!.exercise.metricsSummary!.distanceMillimeters).toBe(
      8_000_000,
    ); // the actively-measured one wins despite shorter distance
  });

  it('passes through records that have no resolvable interval', () => {
    const noIv = dp({ start: '2026-07-23T18:00:00Z' }); // no duration/end
    const good = dp({ start: '2026-07-23T06:00:00Z', durS: 1800 });
    const { canonical, dropped } = dedupeRuns([noIv, good]);
    expect(dropped).toBe(0);
    expect(canonical).toHaveLength(2);
  });
});
