import { stitchLoopAndSpine, MIN_PAD_M } from '@/services/routing/compose';
import type { RouteCandidate } from '@/services/routing/types';

function cand(
  coordinates: number[][],
  distanceM: number,
  seed = 1,
): RouteCandidate {
  return {
    seed,
    distanceM,
    elevationGainM: null,
    coordinates,
    provider: 'ors',
  };
}

describe('stitchLoopAndSpine', () => {
  it('joins loop + spine, dropping the duplicated shared start point', () => {
    // loop: home → A → home ; spine: home → B → finish
    const loop = cand(
      [
        [13.32, 52.49, 40],
        [13.34, 52.5, 45],
        [13.32, 52.49, 40],
      ],
      9000,
    );
    const spine = cand(
      [
        [13.32, 52.49, 40], // same start as loop end
        [13.38, 52.51, 50],
        [13.41, 52.52, 55],
      ],
      6000,
      0,
    );
    const out = stitchLoopAndSpine(loop, spine);
    // 3 loop pts + (3 spine − 1 duplicate) = 5
    expect(out.coordinates).toHaveLength(5);
    expect(out.coordinates[0]).toEqual([13.32, 52.49, 40]); // starts at home
    expect(out.coordinates[out.coordinates.length - 1]).toEqual([
      13.41, 52.52, 55,
    ]); // ends at finish
    expect(out.distanceM).toBe(15000); // additive
    expect(out.seed).toBe(1); // pad loop's seed
  });

  it('recomputes elevation gain from the joined 3-D geometry', () => {
    const loop = cand(
      [
        [0, 0, 10],
        [0, 0, 30], // +20
        [0, 0, 10],
      ],
      1000,
    );
    const spine = cand(
      [
        [0, 0, 10],
        [0, 0, 25], // +15
      ],
      500,
      0,
    );
    // gains: 10→30 (+20), 30→10 (−), 10→25 (+15) ⇒ 35
    expect(stitchLoopAndSpine(loop, spine).elevationGainM).toBe(35);
  });

  it('exposes a sane minimum pad threshold', () => {
    expect(MIN_PAD_M).toBeGreaterThan(0);
  });
});
