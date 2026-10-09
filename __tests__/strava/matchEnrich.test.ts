import {
  matchActivity,
  MAX_START_DELTA_S,
  type ExistingRunLite,
  type StravaActivityLite,
} from '@/services/strava/matchEnrich';

// Pure matcher — no DB/network. Guards the two hazards the 2026-08-01 dry run
// surfaced: a long run's wide window falsely matching a run that started ~45 min
// later, and split runs (Strava distance disagreeing with the merged DB run).

const T0 = Date.parse('2026-07-23T18:00:00Z');

function run(o: Partial<ExistingRunLite> & { startMs: number }): ExistingRunLite {
  return {
    id: o.id ?? 'run-1',
    startedAtMs: o.startMs,
    durationS: o.durationS ?? 3600,
    distanceKm: o.distanceKm ?? 10,
  };
}
function act(o: Partial<StravaActivityLite> & { startMs: number }): StravaActivityLite {
  return {
    id: o.id ?? 111,
    startMs: o.startMs,
    durationS: o.durationS ?? 3600,
    distanceKm: o.distanceKm ?? 10,
  };
}

describe('matchActivity', () => {
  it('matches a run whose start is within slack and returns the start delta', () => {
    const m = matchActivity(act({ startMs: T0 + 15_000 }), [run({ startMs: T0 })]);
    expect(m?.run.id).toBe('run-1');
    expect(m?.startDeltaS).toBe(15);
  });

  it('returns null when nothing overlaps', () => {
    const far = run({ startMs: T0 + 6 * 3600_000 }); // 6h later
    expect(matchActivity(act({ startMs: T0 }), [far])).toBeNull();
  });

  it('rejects a match beyond MAX_START_DELTA_S even if intervals overlap', () => {
    // A 2h run starting at T0 (interval covers T0..T0+2h). A short activity
    // starting 45 min in overlaps the interval but is a different run.
    const longRun = run({ startMs: T0, durationS: 7200, distanceKm: 20 });
    const late = act({ startMs: T0 + 2750_000, durationS: 1800, distanceKm: 6 });
    expect(2750).toBeGreaterThan(MAX_START_DELTA_S);
    expect(matchActivity(late, [longRun])).toBeNull();
  });

  it('picks the closest run by start time when several overlap', () => {
    const runs = [
      run({ id: 'near', startMs: T0 + 30_000 }),
      run({ id: 'far', startMs: T0 + 200_000, durationS: 7200 }),
    ];
    expect(matchActivity(act({ startMs: T0 }), runs)?.run.id).toBe('near');
  });

  it('reports distDeltaPct so the caller can gate split runs', () => {
    // Strava 6.3 km vs a merged DB run of 12.7 km — the caller skips this.
    const m = matchActivity(
      act({ startMs: T0 + 17_000, distanceKm: 6.33 }),
      [run({ startMs: T0, distanceKm: 12.71 })],
    );
    expect(m).not.toBeNull();
    expect(m!.distDeltaPct!).toBeCloseTo(-50.2, 0);
  });
});
