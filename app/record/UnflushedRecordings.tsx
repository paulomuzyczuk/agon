'use client';

import { useEffect, useState } from 'react';
import {
  discardRecording,
  type ActivityType,
  type RecordingHeader,
} from '@/lib/liveRecordingDb';
import type { ResolvedDistance } from '@/lib/liveRecordingDistance';
import { flushRecording, previewDistance } from './flushRecording';

// The "unfinished recordings" list of app/record (CLAUDE.md "Live Run
// Recording"): every recording still in IndexedDB that never reached
// Postgres — a killed tab, an offline Stop, or one awaiting its distance.
// Save sends the buffered samples to the run or ride finish endpoint
// (./flushRecording.ts); Discard drops them. Since MZY-282 the distance is
// derived from the GPS track (or a ride's wheel sensor) and shown as the
// input's placeholder; typing one overrides it, and it is only required when
// there is nothing to derive it from.

export function UnflushedRecordings({
  recordings,
  onFlushed,
  onFlushError,
  onDiscarded,
}: {
  recordings: RecordingHeader[];
  onFlushed: (activityType: ActivityType, id: string) => void;
  onFlushError: (message: string) => void;
  onDiscarded: () => void;
}) {
  const [distanceByRecording, setDistanceByRecording] = useState<
    Record<string, string>
  >({});
  const [derived, setDerived] = useState<
    Record<string, ResolvedDistance | null>
  >({});
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      recordings.map(
        async (h) =>
          [h.id, await previewDistance(h).catch(() => null)] as const,
      ),
    ).then((entries) => {
      if (!cancelled) setDerived(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [recordings]);

  async function handleSave(header: RecordingHeader) {
    const typed = distanceByRecording[header.id]?.trim();
    const distanceKm = typed ? Number(typed) : undefined;
    if (
      distanceKm !== undefined &&
      (!Number.isFinite(distanceKm) || distanceKm <= 0)
    ) {
      onFlushError('Enter a distance (km) greater than 0, or leave it empty.');
      return;
    }
    if (distanceKm === undefined && !derived[header.id]) {
      onFlushError(
        'No GPS track to measure — enter a distance (km) before saving.',
      );
      return;
    }
    setBusyId(header.id);
    try {
      const saved = await flushRecording(header, distanceKm);
      onFlushed(saved.activityType, saved.id);
    } catch (err) {
      onFlushError(
        err instanceof Error
          ? err.message
          : 'save failed — will retry when back online',
      );
    } finally {
      setBusyId(null);
    }
  }

  async function handleDiscard(header: RecordingHeader) {
    setBusyId(header.id);
    try {
      await discardRecording(header.id);
      onDiscarded();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card" style={{ marginTop: '1rem' }}>
      <p className="muted small">
        Unfinished recording{recordings.length > 1 ? 's' : ''} — not yet saved
        to Postgres (a dropped connection or closed tab, not lost data).
      </p>
      {recordings.map((header) => (
        <div key={header.id} className="rec-unflushed-row">
          <p className="hr-status">
            {new Date(header.startedAt).toLocaleString()} ·{' '}
            {header.activityType ?? 'run'} · {header.deviceName}
          </p>
          <div className="hr-actions">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              placeholder={distancePlaceholder(derived[header.id])}
              className="rec-distance-input"
              value={distanceByRecording[header.id] ?? ''}
              onChange={(e) =>
                setDistanceByRecording((prev) => ({
                  ...prev,
                  [header.id]: e.target.value,
                }))
              }
            />
            <button
              className="nt-btn"
              disabled={busyId === header.id}
              onClick={() => handleSave(header)}
            >
              Save
            </button>
            <button
              className="nt-btn-ghost"
              disabled={busyId === header.id}
              onClick={() => handleDiscard(header)}
            >
              Discard
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** "4.21 km (GPS)" — the derived distance the server will use — or the plain prompt. */
function distancePlaceholder(d: ResolvedDistance | null | undefined): string {
  if (!d) return 'distance (km)';
  return `${d.km.toFixed(2)} km (${d.source === 'gps' ? 'GPS' : 'wheel'})`;
}
