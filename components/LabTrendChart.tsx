'use client';

import { useMemo, useState } from 'react';
import type { LabResultTrendRow } from '@/lib/marts';
import { buildLabTrends, latestLabReadings, type LabTrendSeries } from '@/lib/labTrends';

// Cross-marker lab-result trend chart. Mirrors sihha's PsychometricTrendCard +
// TrendLineChart (public repo components/clinician-charts/): panel-type chips
// toggle groups of markers on/off, one line per marker plotted on a shared
// axis (there: percentile; here: position within the reference range — see
// lib/labTrends.ts), tap a point to pin a detail balloon, and a legend below
// lists each marker's latest reading. Built as a single self-contained
// inline-SVG file, matching Agon's existing chart convention
// (components/WellnessChart.tsx) rather than sihha's generic+specific
// two-component split — Agon has no charting dependency by design.

const AXIS = '#6b7280';
const GRID = '#232830';
const BAND = 'rgba(79, 156, 249, 0.08)'; // shades the 0-100 "within reference range" strip

const LINE_COLORS = ['#4f9cf9', '#4ade80', '#f97362', '#c084fc', '#f5b74a', '#2dd4bf'];
const lineColor = (i: number) => LINE_COLORS[i % LINE_COLORS.length]!;

const FLAG_COLOR: Record<string, string> = {
  low: '#f5b74a',
  high: '#f97362',
  abnormal: '#f97362',
  normal: '#8a919c',
};

const W = 720;
const H = 220;
const PAD_LEFT = 34;
const PAD_RIGHT = 10;
const PAD_TOP = 10;
const PAD_BOTTOM = 22;
const Y_MIN = -50;
const Y_MAX = 150;

function fmtDate(iso: string): string {
  const [, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mi = Number(m) - 1;
  return `${d} ${mi >= 0 && mi < 12 ? months[mi] : m}`;
}

export function LabTrendChart({ results }: { results: LabResultTrendRow[] }) {
  const { dates, series } = useMemo(() => buildLabTrends(results), [results]);
  const latest = useMemo(() => latestLabReadings(results), [results]);
  const groups = [...new Set(series.map((s) => s.group))];
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [pinned, setPinned] = useState<{ s: number; p: number } | null>(null);

  if (series.length === 0) {
    return (
      <p className="muted small">
        No lab results with both a reference low and high yet — those are what chart
        (a marker needs a range to plot on a comparable axis).
      </p>
    );
  }

  const toggleGroup = (group: string) => {
    setHidden((cur) => {
      const next = new Set(cur);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
    setPinned(null);
  };

  const visible = series
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => !hidden.has(s.group));

  const x = (i: number) =>
    dates.length === 1
      ? (PAD_LEFT + W - PAD_RIGHT) / 2
      : PAD_LEFT + (i / (dates.length - 1)) * (W - PAD_LEFT - PAD_RIGHT);
  const y = (value: number) =>
    PAD_TOP + (1 - (value - Y_MIN) / (Y_MAX - Y_MIN)) * (H - PAD_TOP - PAD_BOTTOM);
  const labelStep = Math.max(1, Math.ceil(dates.length / 6));

  const pinnedSeries: LabTrendSeries | undefined = pinned ? visible[pinned.s]?.s : undefined;
  const pinnedPoint = pinnedSeries?.points[pinned!.p];

  return (
    <div>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        {groups.map((group) => (
          <button
            key={group}
            type="button"
            className="nt-btn-ghost"
            style={hidden.has(group) ? undefined : { borderColor: '#4f9cf9', color: '#e7e9ec' }}
            onClick={() => toggleGroup(group)}
          >
            {group}
          </button>
        ))}
      </div>

      <div style={{ position: 'relative' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
          <rect x={PAD_LEFT} y={y(100)} width={W - PAD_LEFT - PAD_RIGHT} height={y(0) - y(100)} fill={BAND} />
          {[Y_MIN, 0, 50, 100, Y_MAX].map((line) => (
            <line
              key={line}
              x1={PAD_LEFT}
              y1={y(line)}
              x2={W - PAD_RIGHT}
              y2={y(line)}
              stroke={line === 0 || line === 100 ? GRID : 'transparent'}
              strokeDasharray={line === 0 || line === 100 ? '2 3' : undefined}
            />
          ))}
          {[0, 50, 100].map((line) => (
            <text key={line} x={PAD_LEFT - 5} y={y(line) + 3} fontSize={9} fill={AXIS} textAnchor="end">
              {line}
            </text>
          ))}
          {dates.map((d, i) =>
            i % labelStep === 0 ? (
              <text key={d} x={x(i)} y={H - 6} fontSize={9} fill={AXIS} textAnchor="middle">
                {fmtDate(d)}
              </text>
            ) : null,
          )}
          {visible.map(({ s, index }, vIndex) => {
            const drawn = s.points
              .map((point, pIndex) => ({ point, pIndex }))
              .filter(({ point }) => point.value !== null);
            const path = drawn
              .map(({ point, pIndex }) => `${x(pIndex).toFixed(1)},${y(point.value!).toFixed(1)}`)
              .join(' ');
            return (
              <g key={s.key}>
                {drawn.length > 1 && (
                  <polyline points={path} fill="none" stroke={lineColor(index)} strokeWidth={2} />
                )}
                {drawn.map(({ point, pIndex }) => {
                  const isPinned = pinned?.s === vIndex && pinned?.p === pIndex;
                  return (
                    <g
                      key={point.date}
                      style={{ cursor: 'pointer' }}
                      onClick={() =>
                        setPinned(isPinned ? null : { s: vIndex, p: pIndex })
                      }
                    >
                      <circle cx={x(pIndex)} cy={y(point.value!)} r={8} fill="transparent" />
                      <circle
                        cx={x(pIndex)}
                        cy={y(point.value!)}
                        r={isPinned ? 4 : 2.2}
                        fill={lineColor(index)}
                      />
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>

        {pinnedSeries && pinnedPoint && (
          <div
            role="tooltip"
            onClick={() => setPinned(null)}
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              background: '#14171c',
              border: '1px solid #232830',
              borderRadius: 8,
              padding: '0.5rem 0.6rem',
              maxWidth: 220,
              cursor: 'pointer',
            }}
          >
            <div className="small" style={{ fontWeight: 600 }}>
              {pinnedSeries.group} · {pinnedSeries.label}
            </div>
            <div className="muted small">
              {fmtDate(pinnedPoint.date)}:{' '}
              {pinnedPoint.raw != null ? `${pinnedPoint.raw}${pinnedPoint.unit ? ` ${pinnedPoint.unit}` : ''}` : '—'}
              {pinnedPoint.flag && pinnedPoint.flag !== 'normal' ? ` (${pinnedPoint.flag})` : ''}
              {pinnedPoint.needsReview ? ' · needs review' : ''}
            </div>
          </div>
        )}
      </div>

      <div className="nt-meal-list" style={{ marginTop: '0.5rem' }}>
        {series.map((s, index) => {
          if (hidden.has(s.group)) return null;
          const reading = latest.get(s.key);
          if (!reading) return null;
          return (
            <div key={s.key} className="small" style={{ display: 'flex', gap: '0.4rem', alignItems: 'baseline' }}>
              <span style={{ color: lineColor(index) }}>●</span>
              <span style={{ flex: 1 }}>
                {s.group} · {s.label}
              </span>
              <span style={{ color: reading.flag ? (FLAG_COLOR[reading.flag] ?? undefined) : undefined }}>
                {reading.raw}
                {reading.unit ? ` ${reading.unit}` : ''}
                {reading.flag && reading.flag !== 'normal' ? ` (${reading.flag})` : ''}
                {reading.needsReview && (
                  <span style={{ color: '#f5b74a' }}> · needs review</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <p className="muted small" style={{ marginTop: '0.4rem' }}>
        Y-axis: position within each marker&apos;s own reference range (0 = low bound,
        100 = high bound; shaded band = in range). Tap a point for its exact value.
      </p>
    </div>
  );
}
