import {
  carbTargetForDuration,
  computeFuelingBalance,
  heatFactor,
  intensityFactor,
  REFERENCE_HRR,
  type FuelingModelInputs,
} from '@/lib/fuelingModel';

const HR_REST = 50;
const HR_MAX = 190;
/** avg HR that sits exactly at the reference HRr → intensity factor 1. */
const REF_HR = HR_REST + REFERENCE_HRR * (HR_MAX - HR_REST); // 141

function inputs(
  overrides: Partial<FuelingModelInputs> = {},
): FuelingModelInputs {
  return {
    durationS: 2 * 3600,
    avgHr: REF_HR,
    hrRest: HR_REST,
    hrMax: HR_MAX,
    tempC: 20,
    humidityPct: 50,
    baselineSweatRateLPerH: 1.0,
    sweatSodiumMgPerL: 1000,
    bodyMassKg: 80,
    intake: null,
    ...overrides,
  };
}

describe('carbTargetForDuration', () => {
  it.each([
    [45 * 60, 0, 30],
    [60 * 60, 30, 60],
    [150 * 60, 30, 60],
    [4 * 3600, 60, 90],
  ])('%is → %i–%i g/h', (s, min, max) => {
    expect(carbTargetForDuration(s)).toEqual({ minGPerH: min, maxGPerH: max });
  });
});

describe('intensityFactor', () => {
  it('is 1 at the reference HRr', () => {
    const r = intensityFactor(REF_HR, HR_REST, HR_MAX);
    expect(r.method).toBe('hr');
    expect(r.factor).toBeCloseTo(1, 6);
  });

  it('assumes baseline intensity without HR', () => {
    expect(intensityFactor(null, HR_REST, HR_MAX)).toEqual({
      factor: 1,
      method: 'assumed',
    });
  });

  it('clamps extreme HRr', () => {
    expect(intensityFactor(HR_MAX, HR_REST, HR_MAX).factor).toBe(1.5);
    expect(intensityFactor(HR_REST, HR_REST, HR_MAX).factor).toBe(0.5);
  });
});

describe('heatFactor', () => {
  it('is neutral at 20 °C / 50% RH and with no weather', () => {
    expect(heatFactor(20, 50)).toBeCloseTo(1, 6);
    expect(heatFactor(null, null)).toBe(1);
  });

  it('rises with heat and humidity, within clamps', () => {
    expect(heatFactor(30, 50)).toBeCloseTo(1.2, 6);
    expect(heatFactor(20, 80)).toBeCloseTo(1.09, 6);
    expect(heatFactor(60, 100)).toBeCloseTo(1.5 * 1.15, 6);
  });
});

describe('computeFuelingBalance', () => {
  it('estimates loss but leaves flags unknown when intake is not logged', () => {
    const b = computeFuelingBalance(inputs());
    expect(b.estSweatRateLPerH).toBeCloseTo(1, 3);
    expect(b.estSweatLossL).toBeCloseTo(2, 3);
    expect(b.estSodiumLossMg).toBe(2000);
    expect(b.intakeLogged).toBe(false);
    expect(b.dehydrated).toBeNull();
    expect(b.underFueled).toBeNull();
  });

  it('flags >2% body-mass loss and under-fueling', () => {
    // 2 L lost, nothing drunk, 80 kg → 2.5% loss; 0 g/h carbs on a 2 h effort.
    const b = computeFuelingBalance(
      inputs({ intake: { waterMl: 0, carbsG: 0, sodiumMg: 0 } }),
    );
    expect(b.bodyMassLossPct).toBe(2.5);
    expect(b.dehydrated).toBe(true);
    expect(b.underFueled).toBe(true);
    expect(b.netSodiumMg).toBe(-2000);
  });

  it('clears both flags for a well-fuelled effort', () => {
    // Drank 1.5 L (0.5 L deficit = 0.625%), 80 g carbs over 2 h = 40 g/h.
    const b = computeFuelingBalance(
      inputs({ intake: { waterMl: 1500, carbsG: 80, sodiumMg: 900 } }),
    );
    expect(b.netFluidL).toBeCloseTo(-0.5, 3);
    expect(b.bodyMassLossPct).toBe(0.63);
    expect(b.carbsPerH).toBe(40);
    expect(b.dehydrated).toBe(false);
    expect(b.underFueled).toBe(false);
  });

  it('reports zero mass loss when intake exceeds sweat loss', () => {
    const b = computeFuelingBalance(
      inputs({ intake: { waterMl: 3000, carbsG: 100, sodiumMg: 0 } }),
    );
    expect(b.netFluidL).toBeCloseTo(1, 3);
    expect(b.bodyMassLossPct).toBe(0);
  });

  it('scales loss with intensity for a hard, hot session', () => {
    const b = computeFuelingBalance(inputs({ avgHr: HR_MAX, tempC: 30 }));
    // 1.0 × 1.5 (clamped intensity) × 1.2 (heat) × 2 h
    expect(b.estSweatLossL).toBeCloseTo(3.6, 3);
  });
});
