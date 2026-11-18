'use client';

import { useEffect, useState } from 'react';
import {
  discardRecording,
  type ActivityType,
  type RecordingHeader,
} from '@/lib/liveRecordingDb';
import {
  parseTypedKm,
  type ResolvedDistance,
} from '@/lib/liveRecordingDistance';
import { flushRecording, previewDistance } from './flushRecording';
import { useRunShoes } from './useRunShoes';

// The "unfinished recordings" list of app/record (CLAUDE.md "Live Run
// Recording"): every recording still in IndexedDB that never reached
// Postgres — a killed tab, an offline Stop, or one awaiting its distance.
// Save sends the buffered samples to the run or ride finish endpoint
// (./flushRecording.ts); Discard drops them. Since MZY-282 the distance is
// derived from the GPS track (or a ride's wheel sensor) and shown as the
// input's placeholder; typing one overrides it, and it is only required when
// there is nothing to derive it from. A run also asks which shoe it was in (a
// dropdown of the registered shoes, the last-used one preselected, like Strava);
// rides have no shoe.

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
  // The athlete's pick per recording; absent = still on the default (the shoe
  // used last), '' = deliberately no shoe.
  const [shoeByRecording, setShoeByRecording] = useState<
    Record<string, string>
  >({});
  const shoes = useRunShoes(recordings.some((h) => activityOf(h) === 'run'));
  const defaultShoe =
    shoes.kind === 'ready' ? (shoes.shoes[0]?.gearId ?? '') : '';

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
    // Two decimals, as stored (10 m): what you type is what the run gets.
    const distanceKm = parseTypedKm(distanceByRecording[header.id]);
    if (distanceKm === 'invalid') {
      onFlushError('Enter a distance of at least 0.01 km, or leave it empty.');
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
      const gearId =
        activityOf(header) === 'run'
          ? (shoeByRecording[header.id] ?? defaultShoe)
          : '';
      const saved = await flushRecording(
        header,
        distanceKm,
        gearId || undefined,
      );
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
            {new Date(header.startedAt).toLocaleString()} · {activityOf(header)}{' '}
            · {header.deviceName}
          </p>
          {activityOf(header) === 'run' && (
            <ShoePicker
              shoes={shoes}
              value={shoeByRecording[header.id] ?? defaultShoe}
              onChange={(gearId) =>
                setShoeByRecording((prev) => ({
                  ...prev,
                  [header.id]: gearId,
                }))
              }
            />
          )}
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

const activityOf = (h: RecordingHeader): ActivityType =>
  h.activityType ?? 'run';

/** "Shoes: [Brooks Ghost Max 2 ▾]" — registered shoes, last used first. */
function ShoePicker({
  shoes,
  value,
  onChange,
}: {
  shoes: ReturnType<typeof useRunShoes>;
  value: string;
  onChange: (gearId: string) => void;
}) {
  return (
    <label className="rec-shoe">
      <span className="rec-shoe-label">Shoes</span>
      <select
        className="rec-shoe-select"
        value={value}
        disabled={shoes.kind !== 'ready'}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">
          {shoes.kind === 'loading'
            ? 'loading…'
            : shoes.kind === 'unavailable'
              ? 'shoes unavailable — save without'
              : 'No shoes'}
        </option>
        {shoes.kind === 'ready' &&
          shoes.shoes.map((s) => (
            <option key={s.gearId} value={s.gearId}>
              {s.name}
            </option>
          ))}
      </select>
    </label>
  );
}
