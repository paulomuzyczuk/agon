import { powerCurveGeometry } from '@/lib/powerCurveChart';

const BOX = { width: 110, height: 60, padL: 10, padR: 0, padT: 0, padB: 10 };

describe('powerCurveGeometry', () => {
  it('is null with fewer than two points', () => {
    expect(powerCurveGeometry([], BOX)).toBeNull();
    expect(powerCurveGeometry([{ durationS: 5, watts: 600 }], BOX)).toBeNull();
  });

  it('places duration on a log axis and watts from zero', () => {
    const g = powerCurveGeometry(
      [
        { durationS: 1, watts: 800 },
        { durationS: 10, watts: 400 },
        { durationS: 100, watts: 200 },
      ],
      BOX,
    )!;
    // log10 spacing: 1 → 10 → 100 are evenly spaced across the 100 px width.
    expect(g.points.map((p) => p.x)).toEqual([10, 60, 110]);
    // 800 W = top (y 0), 400 W = half of the 50 px inner height, 200 = 3/4 down.
    expect(g.points.map((p) => p.y)).toEqual([0, 25, 37.5]);
    expect(g.path).toBe('M10.0,0.0 L60.0,25.0 L110.0,37.5');
    expect(g.yTicks.map((t) => t.watts)).toEqual([0, 400, 800]);
  });

  it('sorts its input and only ticks durations inside the range', () => {
    const g = powerCurveGeometry(
      [
        { durationS: 600, watts: 250 },
        { durationS: 30, watts: 450 },
      ],
      BOX,
    )!;
    expect(g.points.map((p) => p.durationS)).toEqual([30, 600]);
    expect(g.xTicks.map((t) => t.durationS)).toEqual([60, 300]);
  });
});
