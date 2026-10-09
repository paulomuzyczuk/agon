import {
  estimate1RM,
  volumeLoad,
  totalVolumeLoad,
  bestE1RM,
} from '@/lib/liftProgression';

describe('estimate1RM', () => {
  it('computes Epley and Brzycki for a typical set', () => {
    const e = estimate1RM(100, 5);
    expect(e).not.toBeNull();
    expect(e!.epley).toBeCloseTo(100 * (1 + 5 / 30), 5);
    expect(e!.brzycki).toBeCloseTo((100 * 36) / 32, 5);
  });

  it('returns the raw weight-equivalent for a 1-rep set (both formulas agree at reps=1)', () => {
    const e = estimate1RM(140, 1)!;
    expect(e.epley).toBeCloseTo(140 * (1 + 1 / 30), 5);
    expect(e.brzycki).toBeCloseTo((140 * 36) / 36, 5);
    expect(e.brzycki).toBeCloseTo(140, 5);
  });

  it('leaves brzycki null once reps hits the formula\'s undefined point (37)', () => {
    const e = estimate1RM(50, 37)!;
    expect(e.epley).toBeCloseTo(50 * (1 + 37 / 30), 5);
    expect(e.brzycki).toBeNull();
  });

  it('still returns a valid epley estimate past the brzycki cutoff', () => {
    const e = estimate1RM(20, 50)!;
    expect(e.epley).toBeGreaterThan(20);
    expect(e.brzycki).toBeNull();
  });

  it('returns null for non-positive weight or reps', () => {
    expect(estimate1RM(0, 5)).toBeNull();
    expect(estimate1RM(-10, 5)).toBeNull();
    expect(estimate1RM(100, 0)).toBeNull();
    expect(estimate1RM(100, -1)).toBeNull();
  });
});

describe('volumeLoad', () => {
  it('multiplies weight by reps', () => {
    expect(volumeLoad(100, 5)).toBe(500);
  });

  it('is zero for non-positive weight or reps', () => {
    expect(volumeLoad(0, 5)).toBe(0);
    expect(volumeLoad(100, 0)).toBe(0);
    expect(volumeLoad(-5, 5)).toBe(0);
  });
});

describe('totalVolumeLoad', () => {
  it('sums volume-load across working sets', () => {
    const total = totalVolumeLoad([
      { weightKg: 100, reps: 5 },
      { weightKg: 100, reps: 5 },
      { weightKg: 90, reps: 8 },
    ]);
    expect(total).toBe(500 + 500 + 720);
  });

  it('excludes warmup sets', () => {
    const total = totalVolumeLoad([
      { weightKg: 40, reps: 10, isWarmup: true },
      { weightKg: 100, reps: 5 },
    ]);
    expect(total).toBe(500);
  });

  it('is zero for an empty or all-warmup set list', () => {
    expect(totalVolumeLoad([])).toBe(0);
    expect(totalVolumeLoad([{ weightKg: 40, reps: 10, isWarmup: true }])).toBe(0);
  });
});

describe('bestE1RM', () => {
  it('picks the highest Epley estimate among working sets', () => {
    const best = bestE1RM([
      { weightKg: 100, reps: 5 },
      { weightKg: 110, reps: 3 },
      { weightKg: 90, reps: 8 },
    ]);
    const expected = Math.max(
      estimate1RM(100, 5)!.epley,
      estimate1RM(110, 3)!.epley,
      estimate1RM(90, 8)!.epley,
    );
    expect(best).toBeCloseTo(expected, 5);
  });

  it('ignores warmup sets even if they have the heaviest weight', () => {
    const best = bestE1RM([
      { weightKg: 150, reps: 3, isWarmup: true },
      { weightKg: 100, reps: 5 },
    ]);
    expect(best).toBeCloseTo(estimate1RM(100, 5)!.epley, 5);
  });

  it('returns null when there are no valid working sets', () => {
    expect(bestE1RM([])).toBeNull();
    expect(bestE1RM([{ weightKg: 100, reps: 5, isWarmup: true }])).toBeNull();
  });
});
