import { powerCurveGeometry } from '@/lib/powerCurveChart';
import { formatCurveDuration } from '@/lib/ridePower';

// Inline-SVG mean-maximal power curve for the ride-detail view (MZY-269):
// best average watts per duration, log duration axis. Same pure-SVG idiom as
// RunStreamChart (no chart library); the geometry is lib/powerCurveChart.ts.
// Only ever fed a curve computed from a power meter's MEASURED stream.

const BOX = { width: 600, height: 160, padL: 34, padR: 8, padT: 8, padB: 20 };
const AXIS = '#6b7280';
const GRID = '#232830';
const POWER_COLOR = '#f5b942';

export function PowerCurveChart({
  curve,
}: {
  curve: Array<{ durationS: number; watts: number }>;
}) {
  const g = powerCurveGeometry(curve, BOX);
  if (!g) {
    return <p className="muted small">Ride too short for a power curve.</p>;
  }

  return (
    <svg
      viewBox={`0 0 ${BOX.width} ${BOX.height}`}
      width="100%"
      style={{ display: 'block' }}
      role="img"
      aria-label="Best average power for each duration"
    >
      {g.yTicks.map((t) => (
        <g key={t.watts}>
          <line
            x1={BOX.padL}
            y1={t.y}
            x2={BOX.width - BOX.padR}
            y2={t.y}
            stroke={GRID}
            strokeWidth={1}
          />
          <text x={2} y={t.y + 3} fontSize={9} fill={AXIS}>
            {t.watts}
          </text>
        </g>
      ))}
      {g.xTicks.map((t) => (
        <text
          key={t.durationS}
          x={t.x}
          y={BOX.height - 4}
          fontSize={9}
          fill={AXIS}
          textAnchor={tickAnchor(t.x)}
        >
          {formatCurveDuration(t.durationS)}
        </text>
      ))}
      <path
        d={g.path}
        fill="none"
        stroke={POWER_COLOR}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      {g.points.map((p) => (
        <circle key={p.durationS} cx={p.x} cy={p.y} r={2.5} fill={POWER_COLOR}>
          <title>{`${formatCurveDuration(p.durationS)}: ${p.watts} W`}</title>
        </circle>
      ))}
    </svg>
  );
}

/** Keep a tick label at either edge inside the viewBox instead of clipped. */
function tickAnchor(x: number): 'start' | 'middle' | 'end' {
  if (x > BOX.width - BOX.padR - 12) return 'end';
  if (x < BOX.padL + 12) return 'start';
  return 'middle';
}
