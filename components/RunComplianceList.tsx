'use client';

import type { RunComplianceWeek } from '@/lib/marts';

// Weekly run compliance — actual km vs. the training program's target, and
// easy-run HR-cap adherence, each as a threshold-coloured bar (>=90% green,
// 70-89% amber, <70% red — same "under/in-range/over" status-colour
// convention as the nutrition view's MacroValue). No chart library.

const AXIS = '#6b7280';

function statusColor(pct: number | null): string {
  if (pct == null) return AXIS;
  if (pct >= 90) return '#4ade80';
  if (pct >= 70) return '#f5b74a';
  return '#f97362';
}

// Bars scale to 150% so an over-target week (common in this data — up to
// ~124%) still shows visibly longer than a right-at-target week, instead of
// both clipping to the same full-width bar. The 100% reference tick sits at
// 100/150 of the track.
const BAR_SCALE_MAX = 150;
const REF_TICK_PCT = (100 / BAR_SCALE_MAX) * 100;

function Bar({ pct, label }: { pct: number | null; label: string }) {
  const width = pct == null ? 0 : Math.max(2, Math.min(100, (pct / BAR_SCALE_MAX) * 100));
  const color = statusColor(pct);
  return (
    <div className="rc-bar-row">
      <span className="rc-bar-label">{label}</span>
      <div className="rc-bar-track">
        <div className="rc-bar-fill" style={{ width: `${width}%`, background: color }} />
        <div className="rc-bar-ref" style={{ left: `${REF_TICK_PCT}%` }} />
      </div>
      <span className="rc-bar-pct" style={{ color }}>
        {pct != null ? `${pct.toFixed(0)}%` : '—'}
      </span>
    </div>
  );
}

export function RunComplianceList({ weeks }: { weeks: RunComplianceWeek[] }) {
  if (weeks.length === 0) {
    return <p style={{ color: AXIS }}>No compliance data yet.</p>;
  }

  return (
    <ul className="rc-list">
      {weeks.map((w) => (
        <li key={w.blockWeek} className="rc-row">
          <div className="rc-meta">
            <span className="rc-week">{w.blockWeek}</span>
            <span className="rc-sub">
              {w.actualKm != null ? `${w.actualKm.toFixed(1)} km` : '—'}
              {w.targetKm != null ? ` / ${w.targetKm.toFixed(0)} km target` : ''}
              {w.easyRunsCapped != null && w.easyRunsCapped > 0
                ? ` · ${w.easyRunsCompliant}/${w.easyRunsCapped} easy runs in cap`
                : ''}
            </span>
          </div>
          <Bar pct={w.kmCompliancePct} label="Km" />
          <Bar pct={w.hrCompliancePct} label="HR" />
        </li>
      ))}
    </ul>
  );
}
