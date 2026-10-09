'use client';

import type { WellnessDayPoint } from '@/lib/marts';

// Wellness / recovery small-multiples — one pure-SVG sparkline per metric, no
// charting dependency (the repo stays dependency-light). Each row shows the
// metric's latest value, a trend arrow vs the previous reading, and a sparkline
// over the window. The three upstream signals are sparse and don't all overlap,
// so a null day is a GAP in the line, never a zero.

const AXIS = '#6b7280';
const GRID = '#232830';

interface MetricSpec {
  key: string;
  label: string;
  unit: string;
  color: string;
  /** Pull this metric's value from a day (null = no reading). */
  pick: (p: WellnessDayPoint) => number | null;
  /** How to format the latest value. */
  fmt: (v: number) => string;
  /** True when a lower value is the better direction (resting HR) — flips the
   *  trend colour so "down = good" reads green. */
  lowerBetter?: boolean;
}

const METRICS: MetricSpec[] = [
  {
    key: 'rhr',
    label: 'Resting HR',
    unit: 'bpm',
    color: '#f97362',
    pick: (p) => p.restingHr,
    fmt: (v) => v.toFixed(0),
    lowerBetter: true,
  },
  {
    key: 'hrv',
    label: 'HRV (RMSSD)',
    unit: 'ms',
    color: '#4ade80',
    pick: (p) => p.hrvRmssd,
    fmt: (v) => v.toFixed(0),
  },
  {
    key: 'sleep',
    label: 'Sleep',
    unit: 'h',
    color: '#4f9cf9',
    pick: (p) => p.sleepMinutes,
    fmt: (v) => (v / 60).toFixed(1),
  },
  {
    key: 'eff',
    label: 'Sleep efficiency',
    unit: '%',
    color: '#c084fc',
    pick: (p) => p.sleepEfficiency,
    fmt: (v) => v.toFixed(0),
  },
  {
    key: 'active',
    label: 'Active minutes',
    unit: 'min',
    color: '#f5b74a',
    pick: (p) => p.activeMinutes,
    fmt: (v) => v.toFixed(0),
  },
];

const SPARK_W = 200;
const SPARK_H = 34;
const SPARK_PAD = 4;

/** A sparkline that breaks its line wherever a day has no reading (gaps stay
 *  gaps). Values are index-aligned to the full window so every metric's line
 *  shares the same time axis. */
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

  // Build contiguous segments, splitting at nulls so the line never bridges a
  // missing day with a straight edge that implies data.
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

  // Dots at every present point (single-point segments would otherwise be
  // invisible, and they mark the sampling density of a sparse signal).
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

/** Last two non-null readings → a trend glyph coloured by direction. */
function Trend({
  values,
  lowerBetter,
}: {
  values: (number | null)[];
  lowerBetter?: boolean;
}) {
  const present = values.filter((v): v is number => v != null);
  if (present.length < 2) return null;
  const last = present[present.length - 1]!;
  const prev = present[present.length - 2]!;
  const delta = last - prev;
  if (delta === 0) {
    return (
      <span className="wl-trend" style={{ color: AXIS }}>
        →
      </span>
    );
  }
  const up = delta > 0;
  const good = lowerBetter ? !up : up;
  return (
    <span
      className="wl-trend"
      style={{ color: good ? '#4ade80' : '#f97362' }}
    >
      {up ? '▲' : '▼'} {Math.abs(delta).toFixed(delta % 1 === 0 ? 0 : 1)}
    </span>
  );
}

export function WellnessChart({ series }: { series: WellnessDayPoint[] }) {
  if (series.length === 0) {
    return <p style={{ color: AXIS }}>No wellness data yet.</p>;
  }

  const first = series[0]!;
  const last = series[series.length - 1]!;

  return (
    <div className="wl-metrics">
      {METRICS.map((m) => {
        const values = series.map((p) => m.pick(p));
        const present = values.filter((v): v is number => v != null);
        const latest = present.length ? present[present.length - 1]! : null;
        return (
          <div key={m.key} className="wl-metric">
            <div className="wl-metric-head">
              <span className="wl-metric-label" style={{ color: m.color }}>
                {m.label}
              </span>
              <span className="wl-metric-value">
                {latest != null ? (
                  <>
                    {m.fmt(latest)}
                    <span className="wl-metric-unit"> {m.unit}</span>
                  </>
                ) : (
                  <span style={{ color: AXIS }}>—</span>
                )}
                <Trend values={values} lowerBetter={m.lowerBetter} />
              </span>
            </div>
            <Sparkline values={values} color={m.color} />
          </div>
        );
      })}

      <div className="wl-axis">
        <span>{fmtDate(first.date)}</span>
        <span>{fmtDate(last.date)}</span>
      </div>
    </div>
  );
}

function fmtDate(iso: string): string {
  // `YYYY-MM-DD` → `DD Mon` (compact, locale-stable, no timezone maths).
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
