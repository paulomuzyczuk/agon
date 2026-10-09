'use client';

import type { RelativeEffortMethod, RelativeEffortRun } from '@/lib/marts';

// Per-run Relative Effort (Banister TRIMP) — a compact list, no chart library.
// Each row: date + block/week/distance, the score with a bar scaled to the
// window's max, and RE-per-hour. The `method` is surfaced as a coloured badge so
// avg-HR / pace-estimated runs read as visibly less certain than the
// stream-integrated ones.

const AXIS = '#6b7280';

// Certainty ladder: full HR stream = most trustworthy, then avg HR, then a
// pace-only estimate (no HR at all). Colour carries that from bar to badge.
const METHOD_STYLE: Record<
  RelativeEffortMethod,
  { label: string; color: string }
> = {
  stream: { label: 'stream', color: '#4ade80' }, // green — full HR series
  average: { label: 'avg HR', color: '#f5b74a' }, // amber — average only
  estimated_pace: { label: 'est. pace', color: '#f97362' }, // red — no HR
};

function fmtDate(iso: string): string {
  // `YYYY-MM-DD` → `DD Mon` (compact, locale-stable, no timezone maths).
  const [, m, d] = iso.split('-');
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
  const mon = mi >= 0 && mi < 12 ? months[mi]! : (m ?? '');
  return `${d} ${mon}`;
}

export function RelativeEffortList({ runs }: { runs: RelativeEffortRun[] }) {
  if (runs.length === 0) {
    return <p style={{ color: AXIS }}>No scored runs yet.</p>;
  }

  const maxScore = Math.max(1, ...runs.map((r) => r.relativeEffort));

  return (
    <ul className="re-list">
      {runs.map((r) => {
        const style = METHOD_STYLE[r.method];
        const pct = Math.max(2, (r.relativeEffort / maxScore) * 100);
        const sub = [
          r.block != null && r.week != null ? `Wk ${r.week}` : null,
          r.distanceKm != null ? `${r.distanceKm.toFixed(1)} km` : null,
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <li key={r.runId} className="re-row">
            <div className="re-meta">
              <span className="re-date">{fmtDate(r.date)}</span>
              <span className="re-sub">
                {sub || '—'}
                <span
                  className="re-method"
                  style={{
                    marginLeft: 6,
                    color: style.color,
                    background: `${style.color}1f`,
                  }}
                >
                  {style.label}
                </span>
              </span>
            </div>

            <div>
              <div className="re-score">{r.relativeEffort.toFixed(0)}</div>
              {r.relativeEffortPerHour != null && (
                <div className="re-per-hour">
                  {r.relativeEffortPerHour.toFixed(0)} /h
                </div>
              )}
            </div>

            <div className="re-bar-track">
              <div
                className="re-bar-fill"
                style={{ width: `${pct}%`, background: style.color }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
