'use client';

import type { BodyCompPoint } from '@/lib/marts';

// Body-composition small-multiples — one pure-SVG sparkline per metric, same
// widget as WellnessChart (no charting dependency). Each row shows the metric's
// latest value, a trend arrow vs the previous reading, and a sparkline over the
// full history. Weigh-ins are sparse and irregular, so a null day is a GAP in the
// line, never a zero.

const AXIS = '#6b7280';
const GRID = '#232830';

interface MetricSpec {
  key: string;
  label: string;
  unit: string;
  color: string;
  pick: (p: BodyCompPoint) => number | null;
  fmt: (v: number) => string;
}

const METRICS: MetricSpec[] = [
  {
    key: 'weight',
    label: 'Weight',
    unit: 'kg',
    color: '#4f9cf9',
    pick: (p) => p.weightKg,
    fmt: (v) => v.toFixed(1),
  },
  {
    key: 'bf',
    label: 'Body fat',
    unit: '%',
    color: '#f5b74a',
    pick: (p) => p.bodyFatPct,
    fmt: (v) => v.toFixed(1),
  },
];

const SPARK_W = 200;
const SPARK_H = 34;
const SPARK_PAD = 4;

/** A sparkline that breaks its line wherever a day has no reading. Values are
 *  index-aligned to the full window so every metric shares the same time axis. */
function Sparkline({
  values,
  color,
}: {
  values: (number | null)[];
  color: string;
}) {
  const present = values.filter((v): v is number => v != null);
  if (present.length === 0) {
    return (
      <svg
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        width="100%"
        style={{ display: 'block' }}
        aria-hidden="true"
      >
        <line
          x1={0}
          y1={SPARK_H / 2}
          x2={SPARK_W}
          y2={SPARK_H / 2}
          stroke={GRID}
          strokeDasharray="2 3"
          strokeWidth={1}
        />
      </svg>
    );
  }

  const min = Math.min(...present);
  const max = Math.max(...present);
  const span = max - min || 1;
  const innerW = SPARK_W - SPARK_PAD * 2;
  const innerH = SPARK_H - SPARK_PAD * 2;
  const n = values.length;
  const dx = n > 1 ? innerW / (n - 1) : 0;

  const xy = (i: number, v: number): [number, number] => [
    SPARK_PAD + i * dx,
    SPARK_PAD + innerH - ((v - min) / span) * innerH,
  ];

  const segments: string[] = [];
  let cur: string[] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (cur.length) {
        segments.push(cur.join(' '));
        cur = [];
      }
      return;
    }
    const [x, y] = xy(i, v);
    cur.push(`${cur.length === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (cur.length) segments.push(cur.join(' '));

  const dots: [number, number][] = [];
  values.forEach((v, i) => {
    if (v != null) dots.push(xy(i, v));
  });
  const lastDot = dots[dots.length - 1];

  return (
    <svg
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      width="100%"
      style={{ display: 'block' }}
      aria-hidden="true"
    >
      {segments.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
      {dots.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={1.2} fill={color} opacity={0.5} />
      ))}
      {lastDot && (
        <circle cx={lastDot[0]} cy={lastDot[1]} r={2.4} fill={color} />
      )}
    </svg>
  );
}

/** Last two non-null readings → a trend glyph. Lower is always "good" here — the
 *  athlete is cutting from the Athlete Profile's starting weight/BF% — so a
 *  decrease is always coloured green, an increase always red. */
function Trend({ values }: { values: (number | null)[] }) {
  const present = values.filter((v): v is number => v != null);
  if (present.length < 2) return null;
  const last = present[present.length - 1]!;
  const prev = present[present.length - 2]!;
  const delta = last - prev;
  if (delta === 0) {
    return (
      <span className="bc-trend" style={{ color: AXIS }}>
        →
      </span>
    );
  }
  const up = delta > 0;
  return (
    <span className="bc-trend" style={{ color: up ? '#f97362' : '#4ade80' }}>
      {up ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}
    </span>
  );
}

export function BodyCompChart({ series }: { series: BodyCompPoint[] }) {
  if (series.length === 0) {
    return <p style={{ color: AXIS }}>No body-composition data yet.</p>;
  }

  const first = series[0]!;
  const last = series[series.length - 1]!;

  return (
    <div className="bc-metrics">
      {METRICS.map((m) => {
        const values = series.map((p) => m.pick(p));
        const present = values.filter((v): v is number => v != null);
        const latest = present.length ? present[present.length - 1]! : null;
        return (
          <div key={m.key} className="bc-metric">
            <div className="bc-metric-head">
              <span className="bc-metric-label" style={{ color: m.color }}>
                {m.label}
              </span>
              <span className="bc-metric-value">
                {latest != null ? (
                  <>
                    {m.fmt(latest)}
                    <span className="bc-metric-unit"> {m.unit}</span>
                  </>
                ) : (
                  <span style={{ color: AXIS }}>—</span>
                )}
                <Trend values={values} />
              </span>
            </div>
            <Sparkline values={values} color={m.color} />
          </div>
        );
      })}

      <div className="bc-axis">
        <span>{fmtDate(first.date)}</span>
        <span>{fmtDate(last.date)}</span>
      </div>
    </div>
  );
}

function fmtDate(iso: string): string {
  const parts = iso.split('-');
  const m = parts[1] ?? '';
  const d = parts[2] ?? '';
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const mi = Number(m) - 1;
  const mon = mi >= 0 && mi < 12 ? months[mi]! : m;
  return `${d} ${mon}`;
}
