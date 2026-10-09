// Pure geometry for the ride-detail power curve (MZY-269), kept out of the
// component so it is unit-testable. Duration runs on a LOG x axis — 1 s and
// 2 h on one chart is the whole point of a mean-maximal curve, and a linear
// axis would crush everything under 5 min into the left edge.

export interface CurveBox {
  width: number;
  height: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
}

export interface CurveGeometry {
  /** SVG path through every point, in ascending duration. */
  path: string;
  /** Plotted points (for markers/titles). */
  points: Array<{ x: number; y: number; durationS: number; watts: number }>;
  /** Duration ticks that fall inside the plotted range. */
  xTicks: Array<{ x: number; durationS: number }>;
  /** Watts gridlines: 0, mid, max. */
  yTicks: Array<{ y: number; watts: number }>;
}

/** Labelled duration ticks: 5 s, 1 min, 5 min, 20 min, 1 h. */
export const CURVE_TICKS_S = [5, 60, 300, 1200, 3600] as const;

/** Geometry for a curve, or null with fewer than 2 points (nothing to draw). */
export function powerCurveGeometry(
  curve: ReadonlyArray<{ durationS: number; watts: number }>,
  box: CurveBox,
): CurveGeometry | null {
  const sorted = [...curve]
    .filter((p) => p.durationS >= 1)
    .sort((a, b) => a.durationS - b.durationS);
  if (sorted.length < 2) return null;

  const minLog = Math.log(sorted[0]!.durationS);
  const maxLog = Math.log(sorted[sorted.length - 1]!.durationS);
  const spanLog = maxLog - minLog || 1;
  // Watts axis from 0, so shape differences are honest (no truncated axis).
  const maxW = Math.max(...sorted.map((p) => p.watts)) || 1;
  const innerW = box.width - box.padL - box.padR;
  const innerH = box.height - box.padT - box.padB;

  const xOf = (durationS: number) =>
    box.padL + ((Math.log(durationS) - minLog) / spanLog) * innerW;
  const yOf = (watts: number) => box.padT + innerH - (watts / maxW) * innerH;

  const points = sorted.map((p) => ({
    x: xOf(p.durationS),
    y: yOf(p.watts),
    durationS: p.durationS,
    watts: p.watts,
  }));
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ');
  const first = sorted[0]!.durationS;
  const last = sorted[sorted.length - 1]!.durationS;
  const xTicks = CURVE_TICKS_S.filter((t) => t >= first && t <= last).map(
    (t) => ({ x: xOf(t), durationS: t }),
  );
  const yTicks = [0, maxW / 2, maxW].map((w) => ({
    y: yOf(w),
    watts: Math.round(w),
  }));
  return { path, points, xTicks, yTicks };
}
