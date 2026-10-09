import {
  findBestEffort,
  findBucketEffort,
  BUCKET_SHORTFALL_TOLERANCE,
  fullStreamEffort,
  wholeRunEffort,
  STANDARD_EFFORT_DISTANCES,
} from '@/lib/bestEfforts';

describe('STANDARD_EFFORT_DISTANCES', () => {
  it('is a non-empty, ascending list of named distances', () => {
    expect(STANDARD_EFFORT_DISTANCES.length).toBeGreaterThan(0);
    for (let i = 1; i < STANDARD_EFFORT_DISTANCES.length; i++) {
      expect(STANDARD_EFFORT_DISTANCES[i]!.meters).toBeGreaterThan(
        STANDARD_EFFORT_DISTANCES[i - 1]!.meters,
      );
    }
    expect(STANDARD_EFFORT_DISTANCES.find((d) => d.name === '5K')?.meters).toBe(5000);
    expect(STANDARD_EFFORT_DISTANCES.find((d) => d.name === 'Marathon')?.meters).toBe(42195);
  });
});

describe('findBestEffort', () => {
  it('finds an exact split for a constant-pace stream (4 m/s, 1 s samples)', () => {
    const n = 2001;
    const timeS = Array.from({ length: n }, (_, i) => i);
    const distanceM = Array.from({ length: n }, (_, i) => i * 4);

    const oneK = findBestEffort(timeS, distanceM, 1000);
    expect(oneK).not.toBeNull();
    expect(oneK!.elapsedS).toBeCloseTo(250, 6); // 1000 / 4 m/s

    const fiveK = findBestEffort(timeS, distanceM, 5000);
    expect(fiveK).not.toBeNull();
    expect(fiveK!.elapsedS).toBeCloseTo(1250, 6);
  });

  it('finds the true fastest sub-segment, not the from-start split', () => {
    // 0-2000m @ medium, 2000-7000m @ fast, 7000-10000m @ slow.
    const distanceM = [0, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
    const timeS = [0, 600, 780, 960, 1140, 1320, 1500, 2000, 2500, 3000];

    const fiveK = findBestEffort(timeS, distanceM, 5000);
    expect(fiveK).not.toBeNull();
    // From-start (idx 0->4) would be 1140s; the true best is idx 1->6 (900s).
    expect(fiveK!.elapsedS).toBeCloseTo(900, 6);
    expect(fiveK!.startIdx).toBe(1);
    expect(fiveK!.endIdx).toBe(6);
  });

  it('linearly interpolates the crossing between two samples', () => {
    // 0-1000m in 200s (5 m/s), then 1000-3000m in 500s (4 m/s).
    const distanceM = [0, 1000, 3000];
    const timeS = [0, 200, 700];
    const twoK = findBestEffort(timeS, distanceM, 2000);
    expect(twoK).not.toBeNull();
    // 1000m into the second (4 m/s) segment takes 250s -> 200 + 250 = 450.
    expect(twoK!.elapsedS).toBeCloseTo(450, 6);
  });

  it('tolerates a GPS distance regression without crashing or going negative', () => {
    const distanceM = [0, 1000, 950, 3000]; // small regression at idx 2
    const timeS = [0, 200, 210, 700];
    const result = findBestEffort(timeS, distanceM, 2000);
    expect(result).not.toBeNull();
    expect(result!.elapsedS).toBeGreaterThan(0);
  });

  it('returns null when the stream never covers the target distance', () => {
    const distanceM = [0, 1000, 2000];
    const timeS = [0, 100, 200];
    expect(findBestEffort(timeS, distanceM, 5000)).toBeNull();
  });

  it('returns null for too-short, mismatched, or invalid inputs', () => {
    expect(findBestEffort([0], [0], 1000)).toBeNull();
    expect(findBestEffort([0, 1], [0, 1, 2], 1000)).toBeNull();
    expect(findBestEffort([0, 100], [0, 1000], 0)).toBeNull();
  });
});

describe('findBucketEffort', () => {
  it('returns the ordinary best effort when the stream covers the bucket', () => {
    const distanceM = [0, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
    const timeS = [0, 600, 780, 960, 1140, 1320, 1500, 2000, 2500, 3000];
    expect(findBucketEffort(timeS, distanceM, 5000)).toEqual(findBestEffort(timeS, distanceM, 5000));
  });

  it('counts a stream a few metres short, scaled up to the full distance at its own pace', () => {
    // 4998 m in 1386 s — the live 2026-07-14 5K after stop-drift freezing.
    const result = findBucketEffort([0, 693, 1386], [0, 2499, 4998], 5000);
    expect(result).not.toBeNull();
    expect(result!.elapsedS).toBeCloseTo((1386 * 5000) / 4998, 6);
    expect(result!.elapsedS).toBeGreaterThan(1386); // never faster than recorded
  });

  it('accepts exactly the tolerance edge (4990 m for a 5K) and refuses beyond it', () => {
    const edge = 5000 * (1 - BUCKET_SHORTFALL_TOLERANCE);
    expect(edge).toBeCloseTo(4990, 6);
    expect(findBucketEffort([0, 1400], [0, edge], 5000)).not.toBeNull();
    expect(findBucketEffort([0, 1400], [0, 4980], 5000)).toBeNull();
  });

  it('returns null for too-short, mismatched, or invalid inputs', () => {
    expect(findBucketEffort([0], [0], 1000)).toBeNull();
    expect(findBucketEffort([0, 1], [0, 1, 2], 1000)).toBeNull();
    expect(findBucketEffort([0, 100], [0, 1000], 0)).toBeNull();
  });
});

describe('fullStreamEffort', () => {
  it('reads the whole run from the first/last sample', () => {
    const timeS = [0, 100, 200, 300];
    const distanceM = [0, 400, 800, 1200];
    const effort = fullStreamEffort(timeS, distanceM);
    expect(effort).toEqual({ distanceM: 1200, timeS: 300 });
  });

  it('returns null for a too-short or non-positive stream', () => {
    expect(fullStreamEffort([0], [0])).toBeNull();
    expect(fullStreamEffort([0, 100], [500, 500])).toBeNull(); // zero distance
    expect(fullStreamEffort([100, 100], [0, 500])).toBeNull(); // zero elapsed
  });
});

describe('wholeRunEffort', () => {
  it('builds a pair from distance/duration', () => {
    expect(wholeRunEffort(21.1, 6000)).toEqual({ distanceM: 21100, timeS: 6000 });
  });

  it('returns null for non-positive distance or duration', () => {
    expect(wholeRunEffort(0, 6000)).toBeNull();
    expect(wholeRunEffort(21.1, 0)).toBeNull();
  });
});
