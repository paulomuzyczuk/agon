import type { DeviceConflict } from '@/lib/sourceDevices';

// Shown whenever one metric is coming from more than one connected device
// (MZY-271). Only the primary's samples are recorded — this tells the athlete
// which device that is and which ones are being ignored, so a surprise (e.g.
// the trainer's power overriding the pedals') is visible before the ride.

export function DeviceConflictAlert({
  conflicts,
}: {
  conflicts: DeviceConflict[];
}) {
  if (conflicts.length === 0) return null;
  return (
    <div className="card" role="alert" style={{ marginTop: '1rem' }}>
      {conflicts.map((c) => (
        <p key={c.metric} className="hr-error">
          {c.label} is coming from {c.ignored.length + 1} devices — recording{' '}
          <strong>{c.recorded}</strong> (primary), ignoring{' '}
          <strong>{c.ignored.join(', ')}</strong>.
        </p>
      ))}
      <p className="muted small">Disconnect one to silence this.</p>
    </div>
  );
}
