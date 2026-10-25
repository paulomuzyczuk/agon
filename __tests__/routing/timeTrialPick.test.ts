import {
  pickTimeTrialRoute,
  timeTrialLabelSuffix,
  type ScoredCandidate,
} from '@/services/routing/timeTrialPick';

// Time-trial route choice — pure.

function scored(
  id: number,
  distanceM: number,
  crossings: [number, number] | null,
  elevationGainM: number | null = 20,
): ScoredCandidate {
  return {
    candidate: {
      seed: id,
      distanceM,
      elevationGainM,
      elevationGainPerKmM: null,
      distanceErrorM: 0,
      coordinates: [],
      provider: 'ors',
    },
    crossings: crossings && {
      trafficSignals: crossings[0],
      plainCrossings: crossings[1],
    },
  };
}

const pick = (pool: ScoredCandidate[], km = 5) =>
  pickTimeTrialRoute(pool, km)?.candidate.seed;

describe('pickTimeTrialRoute', () => {
  it('takes the fewest traffic lights over everything else', () => {
    expect(
      pick([scored(1, 5000, [9, 0], 0), scored(2, 4600, [3, 40], 200)]),
    ).toBe(2);
  });

  it('breaks a traffic-light tie on plain crossings', () => {
    expect(pick([scored(1, 5000, [3, 12]), scored(2, 5000, [3, 5])])).toBe(2);
  });

  it('prefers a loop covering the full distance when crossings tie', () => {
    expect(pick([scored(1, 4800, [3, 5]), scored(2, 5200, [3, 5])])).toBe(2);
    // under 1% short still counts as full, so accuracy decides
    expect(pick([scored(1, 4960, [3, 5]), scored(2, 5200, [3, 5])])).toBe(1);
  });

  it('then the flattest', () => {
    expect(
      pick([scored(1, 5050, [3, 5], 80), scored(2, 5050, [3, 5], 30)]),
    ).toBe(2);
  });

  it('ranks an uncounted route after any counted one', () => {
    expect(pick([scored(1, 5000, null), scored(2, 5000, [40, 40])])).toBe(2);
  });

  it('still picks something when nothing could be counted', () => {
    expect(pick([scored(1, 4500, null), scored(2, 5010, null)])).toBe(2);
  });

  // Regression (2026-10-16): ORS returned a 1.9 km loop for a 10 km trial and
  // it won on traffic lights.
  it('never lets a loop far off the distance win on traffic lights', () => {
    expect(
      pick([scored(1, 1890, [12, 4]), scored(2, 10600, [30, 20])], 10),
    ).toBe(2);
  });

  it('keeps loops within 10% in the running', () => {
    expect(
      pick([scored(1, 9050, [5, 5]), scored(2, 10000, [30, 20])], 10),
    ).toBe(1);
  });

  it('falls back to the closest distance when no loop is within 10%', () => {
    expect(
      pick([scored(1, 1890, [0, 0]), scored(2, 8000, [30, 20])], 10),
    ).toBe(2);
  });

  it('returns null for an empty pool', () => {
    expect(pickTimeTrialRoute([], 5)).toBeNull();
  });
});

describe('timeTrialLabelSuffix', () => {
  it('states the red-light exposure', () => {
    expect(timeTrialLabelSuffix(scored(1, 5000, [1, 3]), 5)).toBe(
      '1 traffic light, 3 other crossings',
    );
  });

  it('says how far to carry on when the loop is short', () => {
    expect(timeTrialLabelSuffix(scored(1, 4800, [0, 1]), 5)).toBe(
      '0 traffic lights, 1 other crossing · run 200 m past the finish',
    );
  });

  it('admits when crossings were not counted', () => {
    expect(timeTrialLabelSuffix(scored(1, 5000, null), 5)).toBe(
      'crossings not counted',
    );
  });
});
