'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import {
  discardGroup,
  retryGroup,
  subscribeOutbox,
  type OutboxSnapshot,
} from '@/lib/outbox';
import { groupEntries } from '@/lib/outboxQueue';
import { startSync, syncNow } from '@/lib/sync/client';
import { exportReplica } from '@/lib/sync/replica';
import { useReplica } from '@/lib/sync/useReplica';

// Writes waiting on this device (MZY-205) — the outbox's equivalent of
// app/record's "unfinished recordings" list. Mounted once in the root layout
// so it's visible from every page; renders nothing while the queue is empty.
// Pending entries flush on their own (reconnect / app start / every 30 s);
// failed ones were rejected by the server and wait for Retry or Discard.
// One line per athlete action, however many field mutations it made.

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function OutboxStatus() {
  const [snap, setSnap] = useState<OutboxSnapshot>({
    entries: [],
    authRequired: false,
  });
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    startSync();
    return subscribeOutbox(setSnap);
  }, []);

  if (snap.entries.length === 0) return <SyncLine />;
  const groups = groupEntries(snap.entries);
  const pending = groups.filter((g) => g.status === 'pending').length;
  const failed = groups.length - pending;

  const headline = [
    pending > 0 &&
      `${pending} change${pending === 1 ? '' : 's'} waiting to sync`,
    failed > 0 && `${failed} failed`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      className={`ob-bar${failed > 0 ? ' ob-bar-failed' : ''}`}
      role="status"
    >
      <button
        type="button"
        className="ob-toggle"
        onClick={() => setOpen(!open)}
      >
        <span className="ob-dot" aria-hidden />
        {headline}
        <span className="muted">{open ? '▲' : '▼'}</span>
      </button>
      {snap.authRequired && (
        <p className="small ob-auth">
          Session expired — saved on this device.{' '}
          <a href={`/login?next=${encodeURIComponent(pathname ?? '/')}`}>
            Sign in to sync
          </a>
        </p>
      )}
      {open && (
        <ul className="ob-list">
          {groups.map((e) => (
            <li key={e.group} className="ob-item">
              <div>
                <div>{e.label}</div>
                <div className="muted small">
                  {timeLabel(e.capturedAt)}
                  {e.status === 'failed' && e.lastError
                    ? ` — ${e.lastError}`
                    : ''}
                  {e.status === 'pending' && e.attempts > 0
                    ? ` — ${e.attempts} attempt${e.attempts === 1 ? '' : 's'}`
                    : ''}
                </div>
              </div>
              {e.status === 'failed' && (
                <div className="ob-actions">
                  <button
                    type="button"
                    className="nt-btn-ghost"
                    onClick={() => retryGroup(e.group)}
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    className="nt-btn-ghost"
                    onClick={() => discardGroup(e.group)}
                  >
                    Discard
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Idle state (nothing queued): when this device last pulled, a manual
 * "Sync now", and "Export" — the device's full replica as JSON, the input to
 * scripts/restore-from-device-export.ts if the server ever loses the data
 * again (MZY-207).
 */
function SyncLine() {
  const { status } = useReplica();
  const pathname = usePathname();
  if (pathname === '/login') return null;

  async function download() {
    const data = await exportReplica();
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `agon-device-export-${data.exportedAt.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="ob-sync small muted" role="status">
      <span>
        {status.syncing
          ? 'Syncing…'
          : status.authRequired
            ? 'Signed out — sign in to sync'
            : status.lastSyncedAt
              ? `Synced ${timeLabel(status.lastSyncedAt)}`
              : 'Not synced yet'}
      </span>
      <button
        type="button"
        className="ob-link"
        disabled={status.syncing}
        onClick={() => void syncNow()}
      >
        Sync now
      </button>
      {status.hydrated && (
        <button
          type="button"
          className="ob-link"
          onClick={() => void download()}
        >
          Export
        </button>
      )}
    </div>
  );
}
