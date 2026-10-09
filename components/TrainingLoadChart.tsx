'use client';

import type { FormZone, TrainingLoadPoint } from '@/lib/marts';

// Pure-SVG Fitness/Fatigue/Form chart — no charting dependency (the repo stays
// dependency-light; see package.json). Renders daily load as faint bars, CTL
// (Fitness) and ATL (Fatigue) as lines, over a responsive viewBox so it scales
// to any phone width. Presentational only: it receives an ascending series.

const COLORS = {
  ctl: '#4f9cf9', // Fitness — blue
  atl: '#f97362', // Fatigue — red
  load: '#2f3540', // daily load bars — faint
  grid: '#20252e',
  axis: '#6b7280',
};

const ZONE_COLOR: Record<FormZone, string> = {
  'high fatigue': '#f97362',
  'optimal training': '#4ade80',
  'grey zone': '#9ca3af',
  fresh: '#4f9cf9',
  transition: '#c084fc',
};

const W = 340;
const H = 160;
const PAD = { top: 12, right: 8, bottom: 18, left: 8 };

function linePath(
  values: number[],
  min: number,
  max: number,
  innerW: number,
  innerH: number,
): string {
  if (values.length === 0) return '';
  const span = max - min || 1;
  const dx = values.length > 1 ? innerW / (values.length - 1) : 0;
  return values
    .map((v, i) => {
      const x = PAD.left + i * dx;
      const y = PAD.top + innerH - ((v - min) / span) * innerH;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export function TrainingLoadChart({ series }: { series: TrainingLoadPoint[] }) {
  if (series.length === 0) {
    return <p style={{ color: COLORS.axis }}>No training-load data yet.</p>;
  }

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const ctl = series.map((p) => p.ctl);
  const atl = series.map((p) => p.atl);
  const loads = series.map((p) => p.dailyLoad);

  // Shared y-scale for CTL/ATL (same units); bars scaled independently so a big
  // single-session load doesn't dwarf the fitness lines.
  const max = Math.max(1, ...ctl, ...atl);
  const maxLoad = Math.max(1, ...loads);
  const barW = Math.max(1, innerW / series.length - 0.5);

  // Non-null: guarded by the series.length === 0 early return above.
  const latest = series[series.length - 1]!;
  const firstDate = series[0]!.date;
  const lastDate = latest.date;

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label="Fitness, fatigue and form over time"
        style={{ display: 'block' }}
      >
        {/* baseline */}
        <line
          x1={PAD.left}
          y1={PAD.top + innerH}
          x2={W - PAD.right}
          y2={PAD.top + innerH}
          stroke={COLORS.grid}
          strokeWidth={1}
        />
        {/* daily load bars */}
        {series.map((p, i) => {
          if (p.dailyLoad <= 0) return null;
          const h = (p.dailyLoad / maxLoad) * innerH;
          const x = PAD.left + (i * innerW) / series.length;
          return (
            <rect
              key={p.date}
              x={x}
              y={PAD.top + innerH - h}
              width={barW}
              height={h}
              fill={COLORS.load}
            />
          );
        })}
        {/* ATL (fatigue) then CTL (fitness) on top */}
        <path
          d={linePath(atl, 0, max, innerW, innerH)}
          fill="none"
          stroke={COLORS.atl}
          strokeWidth={1.5}
        />
        <path
          d={linePath(ctl, 0, max, innerW, innerH)}
          fill="none"
          stroke={COLORS.ctl}
          strokeWidth={1.75}
        />
        {/* date ticks */}
        <text x={PAD.left} y={H - 4} fill={COLORS.axis} fontSize={9}>
          {firstDate}
        </text>
        <text
          x={W - PAD.right}
          y={H - 4}
          fill={COLORS.axis}
          fontSize={9}
          textAnchor="end"
        >
          {lastDate}
        </text>
      </svg>

      <figcaption
        style={{
          display: 'flex',
          gap: '0.75rem',
          marginTop: '0.5rem',
          fontSize: '0.75rem',
          color: COLORS.axis,
        }}
      >
        <Legend color={COLORS.ctl} label={`Fitness ${latest.ctl.toFixed(0)}`} />
        <Legend color={COLORS.atl} label={`Fatigue ${latest.atl.toFixed(0)}`} />
        <Legend color={COLORS.load} label="Daily load" />
      </figcaption>
    </figure>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span
        style={{
          width: 10,
          height: 3,
          background: color,
          borderRadius: 2,
          display: 'inline-block',
        }}
      />
      {label}
    </span>
  );
}

export function FormBadge({
  tsb,
  zone,
}: {
  tsb: number;
  zone: FormZone;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px',
        borderRadius: 999,
        background: `${ZONE_COLOR[zone]}22`,
        color: ZONE_COLOR[zone],
        fontSize: '0.8rem',
        fontWeight: 600,
      }}
    >
      Form {tsb > 0 ? '+' : ''}
      {tsb.toFixed(0)} · {zone}
    </span>
  );
}
