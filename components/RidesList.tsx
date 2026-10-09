'use client';

import Link from 'next/link';
import type { RideListItem } from '@/lib/rideMarts';
import { fmtDuration } from '@/components/RunsList';
import { CorrectedBadge } from '@/components/ActivityCorrectionPanel';

// Recent-rides list — distance/speed/HR/weather per ride, each row linking to
// its detail page. Mirrors RunsList's compact grid-row idiom.

const AXIS = '#6b7280';

function fmtDate(iso: string): string {
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

export function fmtSpeed(kmh: number | null): string | null {
  if (kmh == null) return null;
  return `${kmh.toFixed(1)} km/h`;
}

export function RidesList({ rides }: { rides: RideListItem[] }) {
  if (rides.length === 0) {
    return <p style={{ color: AXIS }}>No rides yet.</p>;
  }

  return (
    <ul className="re-list">
      {rides.map((r) => {
        const sub = [
          r.distanceKm != null ? `${r.distanceKm.toFixed(1)} km` : null,
          fmtSpeed(r.avgSpeedKmh),
          r.avgHr != null ? `${r.avgHr} bpm` : null,
          r.tempC != null ? `${r.tempC.toFixed(0)}°C` : null,
          r.hasRoute ? '🗺️' : null,
        ]
          .filter(Boolean)
          .join(' · ');

        return (
          <li key={r.id}>
            <Link href={`/rides/${r.id}`} className="re-row run-row-link">
              <div className="re-meta">
                <span className="re-date">
                  {fmtDate(r.date)} {r.corrected && <CorrectedBadge />}
                </span>
                <span className="re-sub">{sub || '—'}</span>
              </div>
              <div>
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
