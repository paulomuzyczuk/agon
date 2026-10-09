import {
  linkActivity,
  reconcile,
  toActivityTimes,
  type LinkTarget,
  type LocalTimes,
} from '@/services/strava/activityTimes';
import type { StravaSummaryActivity } from '@/services/strava/types';

// Pure paths of the MZY-40 moving/elapsed reference pull: row mapping, linking
// an activity to the Agon run it describes, and the reconciliation stats. No
// network, no DB.

function activity(
  overrides: Partial<StravaSummaryActivity> = {},
): StravaSummaryActivity {
  return {
    id: 1001,
    distance: 10000,
    moving_time: 3000,
    elapsed_time: 3100,
    sport_type: 'Run',
    start_date: '2026-09-01T06:00:00Z',
    start_date_local: '2026-09-01T08:00:00',
    ...overrides,
  };
}

function target(overrides: Partial<LinkTarget> = {}): LinkTarget {
  return {
    id: 'run-a',
    startedAtMs: Date.parse('2026-09-01T06:00:20Z'),
    durationS: 3080,
    distanceKm: 10.05,
    source: 'google_health',
    externalId: 'gh-1',
    ...overrides,
  };
}

describe('toActivityTimes', () => {
  it('maps both time fields and keeps only the link matching the kind', () => {
    const row = toActivityTimes(activity(), 'run', {
      runId: 'run-a',
      rideId: 'ride-x',
    });
    expect(row).toEqual({
      stravaActivityId: 1001,
      activityKind: 'run',
      sportType: 'Run',
      startedAt: '2026-09-01T06:00:00.000Z',
      distanceM: 10000,
      movingTimeS: 3000,
      elapsedTimeS: 3100,
      runId: 'run-a',
      rideId: null,
    });
  });

  it('falls back to the legacy type and a null link', () => {
    const row = toActivityTimes(
      activity({ sport_type: undefined, type: 'Ride' }),
      'ride',
    );
    expect(row.sportType).toBe('Ride');
    expect(row.runId).toBeNull();
    expect(row.rideId).toBeNull();
  });
});

describe('linkActivity', () => {
  it('links a source=strava row by external_id even without time overlap', () => {
    const strava = target({
      id: 'run-s',
      source: 'strava',
      externalId: '1001',
      startedAtMs: Date.parse('2020-01-01T00:00:00Z'),
    });
    expect(linkActivity(activity(), [target(), strava], new Set())).toEqual({
      id: 'run-s',
      via: 'external_id',
    });
  });

  it('links an overlapping google_health run by time match', () => {
    expect(linkActivity(activity(), [target()], new Set())).toEqual({
      id: 'run-a',
      via: 'time_match',
    });
  });

  it('refuses a time match whose distance disagrees too much (split run)', () => {
    expect(
      linkActivity(activity(), [target({ distanceKm: 20 })], new Set()),
    ).toBeNull();
  });

  it('refuses a row already claimed by another activity', () => {
    expect(linkActivity(activity(), [target()], new Set(['run-a']))).toBeNull();
  });

  it('returns null with no overlapping row', () => {
    const far = target({ startedAtMs: Date.parse('2026-09-02T06:00:00Z') });
    expect(linkActivity(activity(), [far], new Set())).toBeNull();
  });
});

describe('reconcile', () => {
  // 1 Hz stream, 100 s long, with a 20 s stop in the middle (samples 40..59).
  const timeS = Array.from({ length: 101 }, (_, i) => i);
  const moving = timeS.map((i) => !(i >= 40 && i < 60));

  function item(overrides: Partial<LocalTimes> = {}): LocalTimes {
    return {
      label: 'x',
      stravaMovingS: 80,
      stravaElapsedS: 100,
      durationS: 100,
      timeS,
      moving,
      derivedMoving: moving,
      ...overrides,
    };
  }

  const byKey = (
    stats: ReturnType<typeof reconcile>,
    name: string,
    ref: string,
  ) => stats.find((s) => s.estimator === name && s.reference === ref)!;

  it('scores a perfect stream-derived estimate as zero error', () => {
    const stats = reconcile([item()]);
    const s = byKey(stats, 'computeMovingTime(moving)', 'moving');
    expect(s.n).toBe(1);
    expect(s.maeS).toBe(0);
    expect(s.within30sPct).toBe(100);
    expect(byKey(stats, 'stream span', 'elapsed').maeS).toBe(0);
  });

  it('reports signed bias, MAE and MAPE for duration_s vs moving', () => {
    const stats = reconcile([
      item({ durationS: 100 }), // +20 vs moving 80
      item({ durationS: 70 }), //  −10
    ]);
    const s = byKey(stats, 'duration_s', 'moving');
    expect(s.meanBiasS).toBe(5);
    expect(s.maeS).toBe(15);
    expect(s.mapePct).toBeCloseTo(((20 / 80 + 10 / 80) / 2) * 100);
    expect(s.worst[0]!.deltaS).toBe(20);
  });

  it('excludes activities an estimator cannot score', () => {
    const stats = reconcile([
      item({ timeS: null, moving: null, derivedMoving: null }),
    ]);
    expect(byKey(stats, 'computeMovingTime(moving)', 'moving').n).toBe(0);
    expect(byKey(stats, 'stream span', 'elapsed').n).toBe(0);
    expect(byKey(stats, 'duration_s', 'elapsed').n).toBe(1);
  });
});
