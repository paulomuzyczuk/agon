// Inline-SVG GPS route — no mapping library (the repo stays dependency-light,
// same call as WellnessChart/TrainingLoadChart). Equirectangular projection
// (lng scaled by cos(avg lat), so a route near Berlin isn't visibly stretched
// east-west) normalized to a uniform-scale viewBox — a square run reads as a
// square, not a rectangle.

const ROUTE_W = 320;
const ROUTE_H = 320;
const PAD = 12;
const ACCENT = '#4f9cf9';

export function RunRoute({
  lat,
  lng,
}: {
  lat: (number | null)[];
  lng: (number | null)[];
}) {
  const points: [number, number][] = [];
  for (let i = 0; i < lat.length; i++) {
    const la = lat[i];
    const lo = lng[i];
    if (la != null && lo != null) points.push([la, lo]);
  }

  if (points.length < 2) {
    return <p className="muted small">No GPS route for this run.</p>;
  }

  const avgLat = points.reduce((s, [la]) => s + la, 0) / points.length;
  const cosLat = Math.cos((avgLat * Math.PI) / 180);
  const projected = points.map(([la, lo]): [number, number] => [
    lo * cosLat,
    -la,
  ]);

  const xs = projected.map(([x]) => x);
  const ys = projected.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1e-9;
  const spanY = maxY - minY || 1e-9;
  const innerW = ROUTE_W - PAD * 2;
  const innerH = ROUTE_H - PAD * 2;
  // Uniform scale on the larger span so the route isn't stretched.
  const scale = Math.min(innerW / spanX, innerH / spanY);
  const offsetX = PAD + (innerW - spanX * scale) / 2;
  const offsetY = PAD + (innerH - spanY * scale) / 2;

  const toSvg = ([x, y]: [number, number]): [number, number] => [
    offsetX + (x - minX) * scale,
    offsetY + (y - minY) * scale,
  ];

  const svgPoints = projected.map(toSvg);
  const d = svgPoints
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');
  const [startX, startY] = svgPoints[0]!;
  const [endX, endY] = svgPoints[svgPoints.length - 1]!;

  return (
    <svg
      viewBox={`0 0 ${ROUTE_W} ${ROUTE_H}`}
      width="100%"
      style={{ display: 'block', maxWidth: `${ROUTE_W}px`, margin: '0 auto' }}
      role="img"
      aria-label="GPS route"
    >
      <path
        d={d}
        fill="none"
        stroke={ACCENT}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={startX} cy={startY} r={4} fill="#4ade80" />
      <circle cx={endX} cy={endY} r={4} fill="#f97362" />
    </svg>
  );
}
