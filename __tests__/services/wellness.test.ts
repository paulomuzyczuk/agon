import { computeWellnessLatest } from '@/services/marts/wellness';
import type { WellnessDayPoint } from '@/lib/marts';

// Unit coverage for the pure `computeWellnessLatest` derivation (no DB). The
// query side (getWellnessSeries) is thin SQL over the dbt mart and is exercised
// end-to-end; the logic worth pinning here is the per-metric backward walk over a
// SPARSE series and the minutes→hours conversion.

function day(overrides: Partial<WellnessDayPoint>): WellnessDayPoint {
  return {
    date: '2026-08-01',
    restingHr: null,
    activeMinutes: null,
    hrvRmssd: null,
    hrvDeepRmssd: null,
    sleepMinutes: null,
    sleepEfficiency: null,
    sleepDeepMin: null,
    sleepLightMin: null,
    sleepRemMin: null,
    sleepWakeMin: null,
    ...overrides,
  };
}

describe('computeWellnessLatest', () => {
  it('returns all-null for an empty series', () => {
    expect(computeWellnessLatest([])).toEqual({
      restingHr: null,
      hrvRmssd: null,
      sleepHours: null,
      sleepEfficiency: null,
      activeMinutes: null,
    });
  });

  it('picks each metric independently from its own most-recent non-null day', () => {
    // Sparse, non-overlapping: resting HR only on day 1, sleep only on day 2,
    // HRV only on day 3. Each latest must come from a DIFFERENT day.
    const series: WellnessDayPoint[] = [
      day({ date: '2026-08-01', restingHr: 60 }),
      day({ date: '2026-08-02', sleepMinutes: 420, sleepEfficiency: 90 }),
      day({ date: '2026-08-03', hrvRmssd: 55 }),
    ];

    const latest = computeWellnessLatest(series);

    expect(latest.restingHr).toEqual({ value: 60, date: '2026-08-01' });
    expect(latest.hrvRmssd).toEqual({ value: 55, date: '2026-08-03' });
    expect(latest.sleepEfficiency).toEqual({ value: 90, date: '2026-08-02' });
    // 420 min → 7.0 h, tagged with the sleep day (not the last day of the series).
    expect(latest.sleepHours).toEqual({ value: 7, date: '2026-08-02' });
    expect(latest.activeMinutes).toBeNull();
  });

  it('prefers the later reading when a metric appears on multiple days', () => {
    const series: WellnessDayPoint[] = [
      day({ date: '2026-08-01', restingHr: 62 }),
      day({ date: '2026-08-05', restingHr: 58 }),
      day({ date: '2026-08-09' }), // gap after the latest reading
    ];
    expect(computeWellnessLatest(series).restingHr).toEqual({
      value: 58,
      date: '2026-08-05',
    });
  });
});
