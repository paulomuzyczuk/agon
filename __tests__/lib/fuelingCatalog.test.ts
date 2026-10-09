import {
  canonicalFuelingName,
  fuelingServings,
  estimateFuelingBottles,
  STANDARD_FUELING_SOLUTION,
} from '@/lib/fuelingCatalog';

// Bottle-count scaling: FUELING_BASE_BOTTLES (2) at LONG_RUN_REMINDER_KM
// (15 km), one more every FUELING_BOTTLE_STEP_KM (5 km) beyond — calibrated
// against the athlete's own reported real intake (2 bottles, ~1L, on 15 km
// runs) rather than a guess. See lib/constants.ts for the sports-science
// cross-check (NSCA 30-60 g/h carb guideline, sweat-rate-relative fluid dosing).

describe('estimateFuelingBottles', () => {
  it('returns null below the threshold', () => {
    expect(estimateFuelingBottles(14.9)).toBeNull();
  });

  it('is 2 bottles right at the 15 km threshold', () => {
    expect(estimateFuelingBottles(15)?.bottles).toBe(2);
  });

  it('holds at 2 bottles until the next 5 km step', () => {
    expect(estimateFuelingBottles(16)?.bottles).toBe(2);
    expect(estimateFuelingBottles(18)?.bottles).toBe(2);
    expect(estimateFuelingBottles(19.9)?.bottles).toBe(2);
  });

  it('steps up to 3 bottles at 20 km, per the athlete-reported anchor', () => {
    expect(estimateFuelingBottles(20)?.bottles).toBe(3);
  });

  it('steps up to 4 bottles at 25 km, per the athlete-reported anchor', () => {
    expect(estimateFuelingBottles(25)?.bottles).toBe(4);
  });

  it('keeps scaling beyond the reported anchors', () => {
    expect(estimateFuelingBottles(30)?.bottles).toBe(5);
  });

  it('computes combined macros as bottles × the catalog per-bottle values', () => {
    const est = estimateFuelingBottles(20);
    expect(est).toMatchObject({
      bottles: 3,
      kcal: 3 * STANDARD_FUELING_SOLUTION.kcal,
      carbsG: 3 * STANDARD_FUELING_SOLUTION.carbsG,
      sodiumMg: 3 * STANDARD_FUELING_SOLUTION.sodiumMg,
    });
  });

  it('surfaces the bottle recipe out of the catalog servingDesc', () => {
    expect(estimateFuelingBottles(15)?.recipe).toBe(
      '450 ml water + 30 g honey + 1.2 g kitchen salt',
    );
  });
});

describe('canonicalFuelingName', () => {
  it('matches catalog names case-insensitively', () => {
    expect(canonicalFuelingName('powerade')).toBe('Powerade');
    expect(canonicalFuelingName('Standard Fueling Solution')).toBe(
      'Standard Fueling Solution',
    );
  });

  it('drops a parenthetical before matching', () => {
    expect(canonicalFuelingName('water (1 liter; not 100% sure)')).toBe(
      'Water',
    );
    expect(canonicalFuelingName('honey (110-120 g)')).toBe('Honey');
  });

  it('treats the homemade mix, however described, as Standard Fueling Solution', () => {
    for (const spoken of [
      'honey salt water solution',
      'water/salt/honey solution',
      'honey salt and water standard fueling solution',
      'homemade mix',
      'fueling solution',
    ]) {
      expect(canonicalFuelingName(spoken)).toBe('Standard Fueling Solution');
    }
  });

  it('returns null for anything else rather than guessing', () => {
    expect(canonicalFuelingName('kitchen salt (4-5 g)')).toBeNull();
    expect(canonicalFuelingName('energy bar')).toBeNull();
  });
});

describe('fuelingServings', () => {
  it('converts spoken volumes and masses to catalog servings', () => {
    // The 2026-08-24 note: "1.8 liters of water, 120 grams of honey, 1 liter of Powerade".
    expect(fuelingServings('Water', { amount: 1.8, unit: 'l' })).toBe(3.6);
    expect(fuelingServings('Honey', { amount: 120, unit: 'g' })).toBe(5.71);
    expect(fuelingServings('Powerade', { amount: 1, unit: 'l' })).toBe(2);
    expect(fuelingServings('Water', { amount: 750, unit: 'ml' })).toBe(1.5);
  });

  it("counts the homemade mix in the athlete's own bottles (1 L = 2)", () => {
    expect(
      fuelingServings('Standard Fueling Solution', { amount: 1, unit: 'l' }),
    ).toBe(2);
  });

  it('takes a counted amount as servings', () => {
    expect(fuelingServings('Gu Gel', { amount: 2, unit: 'serving' })).toBe(2);
    expect(fuelingServings('Powerade', { amount: 0.5, unit: null })).toBe(0.5);
  });

  it('falls back to a legacy quantity, then to 1 serving, when no amount is stated', () => {
    expect(fuelingServings('Powerade', { quantity: 3 })).toBe(3);
    expect(fuelingServings('Powerade', {})).toBe(1);
  });

  it('returns null when the unit cannot be converted for that product', () => {
    expect(fuelingServings('Salt Cap', { amount: 5, unit: 'g' })).toBeNull();
    expect(fuelingServings('Honey', { amount: 200, unit: 'ml' })).toBeNull();
  });
});
