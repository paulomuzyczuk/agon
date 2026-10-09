import {
  estimateRunWaterLossL,
  estimateLiftWaterLossL,
  computeWaterGoalL,
  computeMacroTargets,
  estimateLongRunFueling,
} from '@/lib/nutritionGoals';

describe('estimateRunWaterLossL', () => {
  it('multiplies estimated duration by sweat rate', () => {
    // 10 km @ 360 s/km = 3600 s = 1 h, × 0.8 L/h
    expect(estimateRunWaterLossL(10, 360, 0.8)).toBeCloseTo(0.8, 5);
  });

  it('scales with distance', () => {
    expect(estimateRunWaterLossL(20, 360, 0.8)).toBeCloseTo(1.6, 5);
  });
});

describe('estimateLiftWaterLossL', () => {
  it('is a flat duration × rate estimate', () => {
    expect(estimateLiftWaterLossL(1, 0.4)).toBe(0.4);
  });
});

describe('computeWaterGoalL', () => {
  it('adds exercise loss to the base goal', () => {
    expect(computeWaterGoalL(2.5, 1.089)).toBeCloseTo(3.589, 5);
  });

  it('ignores a negative exercise loss (never reduces the base goal)', () => {
    expect(computeWaterGoalL(2.5, -1)).toBe(2.5);
  });

  it('rounds to 3 decimals (NUMERIC(10,3))', () => {
    expect(computeWaterGoalL(2.5, 1.0001234)).toBe(3.5);
    expect(computeWaterGoalL(2.5, 1.0006)).toBe(3.501);
  });
});

describe('estimateLongRunFueling', () => {
  it('derives duration from distance × pace, and water from the water-loss model', () => {
    // 21.1 km @ 360 s/km = 7596 s = 2.11h; water = 2.11 × 0.8
    const est = estimateLongRunFueling(21.1, 360, 0.8, 950, 30, 60);
    expect(est.durationH).toBeCloseTo(2.11, 2);
    expect(est.waterL).toBeCloseTo(1.7, 1); // 2.11 × 0.8 ≈ 1.688 → rounds to 1.7
  });

  it('scales carbs by the g/h guideline range', () => {
    const est = estimateLongRunFueling(21.1, 360, 0.8, 950, 30, 60);
    expect(est.carbsGMin).toBe(63); // 2.11 × 30 ≈ 63.3
    expect(est.carbsGMax).toBe(127); // 2.11 × 60 ≈ 126.6
  });

  it('derives sodium from water loss × concentration', () => {
    const est = estimateLongRunFueling(21.1, 360, 0.8, 950, 30, 60);
    expect(est.sodiumMg).toBe(1604); // ~1.688L × 950 mg/L ≈ 1604
  });
});

describe('computeMacroTargets', () => {
  // 75 kg, 2300-2500 kcal, 1.8-2.2 g/kg protein, 70/30 carb:fat split.
  const base = {
    weightKg: 75,
    kcalMin: 2300,
    kcalMax: 2500,
    proteinGPerKgMin: 1.8,
    proteinGPerKgMax: 2.2,
    carbSharePct: 70,
    fatSharePct: 30,
  };

  it('computes protein directly from bodyweight × g/kg', () => {
    const { proteinG } = computeMacroTargets(base);
    expect(proteinG).toEqual({ min: 135, max: 165 }); // 1.8*75=135, 2.2*75=165
  });

  it('cross-wires kcal and protein extremes for the widest sensible range', () => {
    // remainingMin = kcalMin(2300) - proteinMax_kcal(165*4=660) = 1640
    // remainingMax = kcalMax(2500) - proteinMin_kcal(135*4=540) = 1960
    const { carbsG, fatG } = computeMacroTargets(base);
    expect(carbsG).toEqual({ min: 287, max: 343 }); // 1640*.7/4, 1960*.7/4
    expect(fatG).toEqual({ min: 55, max: 65 }); // 1640*.3/9, 1960*.3/9
  });

  it('roughly reconstitutes the kcal range at each extreme (sanity check)', () => {
    const { proteinG, carbsG, fatG } = computeMacroTargets(base);
    const kcalAtMin = proteinG.max * 4 + carbsG.min * 4 + fatG.min * 9;
    const kcalAtMax = proteinG.min * 4 + carbsG.max * 4 + fatG.max * 9;
    expect(kcalAtMin).toBeCloseTo(base.kcalMin, -1); // within ~10 kcal (rounding)
    expect(kcalAtMax).toBeCloseTo(base.kcalMax, -1);
  });

  it('never lets remaining calories go negative', () => {
    const { carbsG, fatG } = computeMacroTargets({
      ...base,
      kcalMin: 100, // absurdly low vs. protein alone
      kcalMax: 200,
    });
    expect(carbsG.min).toBe(0);
    expect(fatG.min).toBe(0);
  });
});
