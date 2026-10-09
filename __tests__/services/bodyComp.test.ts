import { computeBodyCompLatest } from '@/services/marts/bodyComp';
import type { BodyCompPoint } from '@/lib/marts';

// Unit coverage for the pure `computeBodyCompLatest` derivation (no DB). The
// query side (getBodyCompSeries) is thin SQL over the dbt mart and is exercised
// end-to-end; the logic worth pinning here is the per-metric backward walk over a
// SPARSE series (weight and BF% are usually logged on different days).

function day(overrides: Partial<BodyCompPoint>): BodyCompPoint {
  return {
    date: '2026-08-01',
    weightKg: null,
    bodyFatPct: null,
    ...overrides,
  };
}

describe('computeBodyCompLatest', () => {
  it('returns all-null for an empty series', () => {
    expect(computeBodyCompLatest([])).toEqual({
      weightKg: null,
      bodyFatPct: null,
    });
  });

  it('picks each metric independently from its own most-recent non-null day', () => {
    const series: BodyCompPoint[] = [
      day({ date: '2026-07-22', bodyFatPct: 20.0 }),
      day({ date: '2026-08-28', weightKg: 74.65 }),
      day({ date: '2026-09-06', weightKg: 76.0 }),
    ];

    const latest = computeBodyCompLatest(series);

    expect(latest.weightKg).toEqual({ value: 76.0, date: '2026-09-06' });
    expect(latest.bodyFatPct).toEqual({ value: 20.0, date: '2026-07-22' });
  });

  it('prefers the later reading when a metric appears on multiple days', () => {
    const series: BodyCompPoint[] = [
      day({ date: '2026-03-27', weightKg: 80.0 }),
      day({ date: '2026-04-28', weightKg: 78.35 }),
      day({ date: '2026-05-01' }), // gap after the latest reading
    ];
    expect(computeBodyCompLatest(series).weightKg).toEqual({
      value: 78.35,
      date: '2026-04-28',
    });
  });
});
