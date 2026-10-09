'use client';

import Link from 'next/link';
import type { RunListItem } from '@/lib/marts';
import { CorrectedBadge } from '@/components/ActivityCorrectionPanel';

// Recent-runs list — distance/pace/HR/weather/Relative Effort per run, each
// row linking to its detail page. Mirrors RelativeEffortList's compact
// grid-row idiom (.re-row), reused here as a clickable link.

const AXIS = '#6b7280';

function fmtDate(iso: string): string {
  const [, m, d] = iso.split('-');
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const mi = Number(m) - 1;
  const mon = mi >= 0 && mi < 12 ? months[mi]! : (m ?? '');
  return `${d} ${mon}`;
}

export function fmtPace(sPerKm: number | null): string | null {
  if (sPerKm == null) return null;
  const m = Math.floor(sPerKm / 60);
  const s = Math.round(sPerKm % 60);
  return `${m}:${s.toString().padStart(2, '0')}/km`;
}

export function fmtDuration(s: number | null): string | null {
  if (s == null) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
    : `${m}:${sec.toString().padStart(2, '0')}`;
}

export function RunsList({ runs }: { runs: RunListItem[] }) {
  if (runs.length === 0) {
    return <p style={{ color: AXIS }}>No runs yet.</p>;
  }

  return (
    <ul className="re-list">
      {runs.map((r) => {
        const sub = [
          r.distanceKm != null ? `${r.distanceKm.toFixed(1)} km` : null,
          fmtPace(r.avgPaceSPerKm),
          r.avgHr != null ? `${r.avgHr} bpm` : null,
          r.tempC != null ? `${r.tempC.toFixed(0)}°C` : null,
          r.hasRoute ? '🗺️' : null,
        ]
          .filter(Boolean)
          .join(' · ');

        return (
          <li key={r.id}>
            <Link href={`/runs/${r.id}`} className="re-row run-row-link">
              <div className="re-meta">
                <span className="re-date">
                  {fmtDate(r.date)} {r.corrected && <CorrectedBadge />}
                </span>
                <span className="re-sub">{sub || '—'}</span>
              </div>
              <div>
                {r.relativeEffort != null ? (
                  <div className="re-score">{r.relativeEffort.toFixed(0)}</div>
                ) : (
                  <div className="re-score" style={{ color: AXIS, fontSize: '0.9rem' }}>
                    —
                  </div>
                )}
                {fmtDuration(r.durationS) && (
                  <div className="re-per-hour">{fmtDuration(r.durationS)}</div>
                )}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
