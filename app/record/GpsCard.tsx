'use client';

import type { GpsState } from './gpsLink';

// The phone-GPS status card of app/record (MZY-281). Android app only: in the
// browser (state 'unsupported') it renders nothing — the browser recorder
// stays GPS-less.

export function GpsCard({
  gps,
  onRetry,
  onOpenSettings,
}: {
  gps: GpsState;
  onRetry: () => void;
  onOpenSettings: () => void;
}) {
  if (gps.kind === 'unsupported' || gps.kind === 'idle') return null;
  return (
    <div className="card" style={{ marginTop: '1rem' }}>
      {gps.kind === 'acquiring' && (
        <p className="hr-status">
          GPS · waiting for a fix… (step outside for a clear sky)
        </p>
      )}
      {gps.kind === 'ok' && (
        <p className="hr-status">GPS · ±{Math.round(gps.accuracyM)} m</p>
      )}
      {gps.kind === 'weak' && (
        <p className="hr-status hr-status-stale">
          GPS weak · ±{Math.round(gps.accuracyM)} m — these fixes aren’t
          recorded. If it stays like this, allow precise location for Agon.
        </p>
      )}
      {gps.kind === 'error' && (
        <>
          <p className="hr-error">{gps.message}</p>
          <div className="hr-actions">
            <button className="nt-btn" onClick={onRetry}>
              Try GPS again
            </button>
            {gps.permissionDenied && (
              <button className="nt-btn-ghost" onClick={onOpenSettings}>
                Open settings
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
