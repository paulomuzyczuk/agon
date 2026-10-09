// Inline-SVG HR-over-distance (or over-time, if distance is missing) line
// chart for the run-detail view. Same pure-SVG idiom as WellnessChart's
// Sparkline, scaled up: one axis (HR), thin line, no chart library.

const CHART_W = 600;
const CHART_H = 140;
const PAD_L = 34;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 20;
const AXIS = '#6b7280';
const GRID = '#232830';
const HR_COLOR = '#f97362';

export function RunStreamChart({
  heartrate,
  distanceM,
  timeS,
}: {
  heartrate: (number | null)[];
  distanceM: (number | null)[];
  timeS: (number | null)[];
}) {
  const hr = heartrate.filter((v): v is number => v != null);
  if (hr.length < 2) {
    return <p className="muted small">No heart-rate stream for this run.</p>;
  }

  const useDistance = distanceM.some((v) => v != null);
  const xRaw = useDistance ? distanceM : timeS;

  const points: [number, number][] = [];
  for (let i = 0; i < heartrate.length; i++) {
    const y = heartrate[i];
    const x = xRaw[i];
    if (y != null && x != null) points.push([x, y]);
  }
  if (points.length < 2) {
    return <p className="muted small">No heart-rate stream for this run.</p>;
  }

  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const innerW = CHART_W - PAD_L - PAD_R;
  const innerH = CHART_H - PAD_T - PAD_B;

  const toSvg = ([x, y]: [number, number]): [number, number] => [
    PAD_L + ((x - minX) / spanX) * innerW,
    PAD_T + innerH - ((y - minY) / spanY) * innerH,
  ];

  const svgPoints = points.map(toSvg);
  const d = svgPoints
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');

  const xLabel = (v: number) =>
    useDistance ? `${(v / 1000).toFixed(1)} km` : `${Math.round(v / 60)} min`;

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      width="100%"
      style={{ display: 'block' }}
      role="img"
      aria-label="Heart rate over the run"
    >
      {/* gridlines at min/mid/max HR */}
      {[minY, (minY + maxY) / 2, maxY].map((v, i) => {
        const [, y] = toSvg([minX, v]);
        return (
          <g key={i}>
            <line x1={PAD_L} y1={y} x2={CHART_W - PAD_R} y2={y} stroke={GRID} strokeWidth={1} />
            <text x={2} y={y + 3} fontSize={9} fill={AXIS}>
              {Math.round(v)}
            </text>
          </g>
        );
      })}
      <path d={d} fill="none" stroke={HR_COLOR} strokeWidth={1.5} strokeLinejoin="round" />
      <text x={PAD_L} y={CHART_H - 4} fontSize={9} fill={AXIS}>
        {xLabel(minX)}
      </text>
      <text x={CHART_W - PAD_R} y={CHART_H - 4} fontSize={9} fill={AXIS} textAnchor="end">
        {xLabel(maxX)}
      </text>
    </svg>
  );
}
