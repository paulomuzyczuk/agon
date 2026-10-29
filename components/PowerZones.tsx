import type { PowerZoneRow } from '@/lib/powerZones';
import { fmtDurationS } from '@/lib/activityCorrection';

// Time in power zones for the ride-detail view (MZY-63): one bar per Coggan
// zone, width = share of the ride's active time. Plain divs, no chart library.
// Only ever fed zones computed from a power meter's MEASURED stream and an FTP.

const ZONE_COLORS = [
  '#6b7280',
  '#4f9d69',
  '#a3b84a',
  '#f5b942',
  '#e8833a',
  '#d9534f',
  '#a64ca6',
];

export function PowerZones({ zones }: { zones: PowerZoneRow[] }) {
  return (
    <div role="table" aria-label="Time in power zones">
      {zones.map((z) => (
        <div
          key={z.zone}
          role="row"
          style={{
            display: 'grid',
            gridTemplateColumns: '9.5rem 1fr 4.5rem',
            alignItems: 'center',
            gap: '0.5rem',
            margin: '0.25rem 0',
          }}
        >
          <span className="small" role="cell">
            Z{z.zone} {z.name}{' '}
            <span className="muted">
              {z.maxW === null ? `${z.minW}+ W` : `${z.minW}–${z.maxW} W`}
            </span>
          </span>
          <span
            role="cell"
            style={{ background: '#232830', borderRadius: 3, height: 10 }}
          >
            <span
              style={{
                display: 'block',
                width: `${z.pct}%`,
                height: '100%',
                borderRadius: 3,
                background: ZONE_COLORS[z.zone - 1],
              }}
            />
          </span>
          <span
            className="small muted"
            role="cell"
            style={{ textAlign: 'right' }}
          >
            {fmtDurationS(z.seconds)}
          </span>
        </div>
      ))}
    </div>
  );
}
