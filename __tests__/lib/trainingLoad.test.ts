import { computeTrainingLoad, type DailyLoad } from '@/lib/trainingLoad';

// Pure Banister impulse-response math — no DB, no network. CTL 42-day, ATL 7-day.

/** A flat load every day from start for `n` days. */
function flat(start: string, n: number, load: number): DailyLoad[] {
  const out: DailyLoad[] = [];
  const base = Date.parse(`${start}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    out.push({ date: new Date(base + i * 86_400_000).toISOString().slice(0, 10), load });
  }
  return out;
}

describe('computeTrainingLoad', () => {
  it('returns one row per calendar day, chronological', () => {
    const rows = computeTrainingLoad([
      { date: '2026-01-01', load: 100 },
      { date: '2026-01-03', load: 100 },
    ]);
    expect(rows.map((r) => r.date)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
  });

  it('fills gap days with 0 load (rest days)', () => {
    const rows = computeTrainingLoad([
      { date: '2026-01-01', load: 100 },
      { date: '2026-01-03', load: 100 },
    ]);
    expect(rows[1]).toMatchObject({ date: '2026-01-02', load: 0 });
  });

  it('empty input yields an empty series', () => {
    expect(computeTrainingLoad([])).toEqual([]);
  });

  it('CTL and ATL converge toward a constant daily load', () => {
    // 200 days of steady 100/day → both EWMAs approach 100; ATL (faster) is
    // essentially there, CTL close behind.
    const rows = computeTrainingLoad(flat('2026-01-01', 200, 100));
    const last = rows[rows.length - 1]!;
    expect(last.atl).toBeCloseTo(100, 0);
    expect(last.ctl).toBeGreaterThan(98);
    expect(last.ctl).toBeLessThanOrEqual(100);
  });

  it('ATL responds faster than CTL, so a ramp drives TSB negative', () => {
    const rows = computeTrainingLoad(flat('2026-01-01', 30, 100));
    const last = rows[rows.length - 1]!;
    // Fatigue outruns fitness while load is high → Form is negative.
    expect(last.atl).toBeGreaterThan(last.ctl);
    expect(last.tsb).toBeLessThan(0);
  });

  it('a single hard day spikes ATL more than CTL (acute > chronic)', () => {
    const rows = computeTrainingLoad([{ date: '2026-01-01', load: 210 }]);
    const day = rows[0]!;
    expect(day.atl).toBeGreaterThan(day.ctl); // 210/7=30 vs 210/42=5
    expect(day.atl).toBeCloseTo(30, 1);
    expect(day.ctl).toBeCloseTo(5, 1);
  });

  it('TSB recovers (rises) during rest as fatigue sheds faster than fitness', () => {
    // Build load, then rest 21 days; Form should climb back above 0.
    const load = [...flat('2026-01-01', 30, 100)];
    const rows = computeTrainingLoad(load, { end: '2026-02-20' });
    const built = rows.find((r) => r.date === '2026-01-30')!;
    const rested = rows[rows.length - 1]!;
    expect(rested.tsb).toBeGreaterThan(built.tsb);
    expect(rested.tsb).toBeGreaterThan(0);
  });

  it('prev-day TSB equals yesterday CTL − yesterday ATL', () => {
    // Each field is independently rounded to 1 dp, so allow ≤0.1 rounding slack.
    const rows = computeTrainingLoad(flat('2026-01-01', 10, 100), { tsbMode: 'prev-day' });
    for (let i = 1; i < rows.length; i++) {
      expect(Math.abs(rows[i]!.tsb - (rows[i - 1]!.ctl - rows[i - 1]!.atl))).toBeLessThanOrEqual(0.11);
    }
    expect(rows[0]!.tsb).toBe(0); // seeded at 0
  });

  it('same-day TSB equals today CTL − today ATL', () => {
    const rows = computeTrainingLoad(flat('2026-01-01', 10, 100), { tsbMode: 'same-day' });
    for (const r of rows) expect(Math.abs(r.tsb - (r.ctl - r.atl))).toBeLessThanOrEqual(0.11);
  });

  it('honours an explicit start earlier than the first load (seed ramp-up)', () => {
    const rows = computeTrainingLoad([{ date: '2026-01-10', load: 100 }], {
      start: '2026-01-01',
    });
    expect(rows[0]!.date).toBe('2026-01-01');
    expect(rows[0]).toMatchObject({ load: 0, ctl: 0, atl: 0 });
  });

  it('rejects non-positive time constants', () => {
    expect(() => computeTrainingLoad(flat('2026-01-01', 3, 100), { ctlDays: 0 })).toThrow();
  });
});
