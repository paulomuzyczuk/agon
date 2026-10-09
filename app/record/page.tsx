'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getBleTransport } from '@/lib/ble';
import {
  appendHrSample,
  createRecording,
  listUnflushedRecordings,
  replayJournals,
  stopRecording,
  type ActivityType,
  type RecordingHeader,
} from '@/lib/liveRecordingDb';
import {
  askBatteryExemptionOnce,
  holdAwakeForRecording,
  releaseRecordingWakeLock,
} from '@/lib/recordingPower';
import {
  useCyclingSensors,
  cyclingSensorLabel,
  formatCyclingValue,
} from './useCyclingSensors';
import { UnflushedRecordings } from './UnflushedRecordings';
import { DeviceConflictAlert } from './DeviceConflictAlert';
import { isStale, sensorContactLabel, type HeartRateState } from './heartRate';
import { createHeartRateLink, type HeartRateLink } from './heartRateLink';
import { useGpsTrack } from './useGpsTrack';
import { GpsCard } from './GpsCard';
import { formatPace, paceSecPerKm } from '@/lib/gpsTrack';

// Activity recording (CLAUDE.md "Live Run Recording"; MZY-168 for the cycling
// half): a Strava-Record-shaped page — one Start/Stop control over several
// metric sources, for either a run or a ride. Heart rate (via the 2026-09-05
// Web Bluetooth PoC's pairing/connection state machine) works for BOTH
// activity types (the athlete wears the same Garmin HRM 200 running or
// riding). The Garmin Speed Sensor 2 / Cadence Sensor 2 (BLE Cycling Speed and
// Cadence service, 0x1816) only make sense for a ride, so their section only
// shows once "Ride" is picked. Every sample is written to IndexedDB as it
// arrives (lib/liveRecordingDb.ts) so a dropped connection never loses data,
// then flushed to Postgres run_streams/ride_streams on Stop (or retried later
// — see the "unfinished recordings" section).
//
// The HR strap's connection logic lives in ./heartRateLink.ts and the ride-only
// cycling sensors in ./useCyclingSensors.ts, both over the BleTransport seam
// (lib/ble, MZY-275). In the Android app the phone's GPS (./useGpsTrack.ts,
// MZY-281) adds the route, live distance and pace — enough on its own to
// start a recording without any sensor.

type RecordingUiState =
  | { kind: 'idle' }
  | {
      kind: 'recording';
      recordingId: string;
      startedAt: number;
      sampleCount: number;
    }
  | { kind: 'flushing' }
  | { kind: 'flushed'; activityType: ActivityType; id: string };

export default function RecordPage() {
  const [activityType, setActivityType] = useState<ActivityType>('run');
  const [heartRate, setHeartRate] = useState<HeartRateState>({ kind: 'idle' });
  const [recording, setRecording] = useState<RecordingUiState>({
    kind: 'idle',
  });
  const [unflushed, setUnflushed] = useState<RecordingHeader[]>([]);
  const [flushError, setFlushError] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const hrLinkRef = useRef<HeartRateLink | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const {
    sensors: cyclingSensors,
    conflicts: deviceConflicts,
    connect: handleConnectCyclingSensor,
    connectPowerMeter: handleConnectPowerMeter,
    disconnect: handleDisconnectCyclingSensor,
  } = useCyclingSensors(recordingIdRef, setFlushError);

  /** One more sample buffered for `recordingId` (drives the Stop button's count). */
  const countSample = useCallback((recordingId: string) => {
    setRecording((prev) =>
      prev.kind === 'recording' && prev.recordingId === recordingId
        ? { ...prev, sampleCount: prev.sampleCount + 1 }
        : prev,
    );
  }, []);
  const gpsTrack = useGpsTrack(countSample);
  const { gps } = gpsTrack;

  // Created on first use, never during render (no transport on the server).
  function hrLink(): HeartRateLink {
    hrLinkRef.current ??= createHeartRateLink({
      transport: getBleTransport(),
      setState: setHeartRate,
      getRecordingId: () => recordingIdRef.current,
      appendHrSample,
      onSample: (recordingId) =>
        setRecording((prev) =>
          prev.kind === 'recording' && prev.recordingId === recordingId
            ? { ...prev, sampleCount: prev.sampleCount + 1 }
            : prev,
        ),
    });
    return hrLinkRef.current;
  }

  useEffect(() => {
    if (!hrLink().isAvailable()) setHeartRate({ kind: 'unsupported' });
    return () => hrLinkRef.current?.dispose();
  }, []);

  const refreshUnflushed = useCallback(async () => {
    if (typeof indexedDB === 'undefined') return;
    // After an app kill, restore what only the native journal kept (MZY-294);
    // the live recording's own IndexedDB writes may still be in flight.
    await replayJournals({ skip: recordingIdRef.current }).catch(() => 0);
    setUnflushed(await listUnflushedRecordings());
  }, []);

  useEffect(() => {
    refreshUnflushed();
    const onOnline = () => refreshUnflushed();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [refreshUnflushed]);

  useEffect(() => {
    if (heartRate.kind !== 'connected') return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [heartRate.kind]);

  const handlePair = () => hrLink().pair(); // synchronous: user gesture
  const handleDisconnect = () => hrLink().disconnect();
  const handleReconnect = () => hrLink().reconnect();

  function handleTryAgain() {
    setHeartRate({ kind: 'idle' });
  }

  // ── Start/stop ──────────────────────────────────────────────────────────

  // Any one source is enough: the strap, a cycling sensor (ride), or — in the
  // Android app — a GPS fix on its own.
  const canStartRecording =
    heartRate.kind === 'connected' ||
    gpsTrack.hasFix ||
    (activityType === 'ride' &&
      cyclingSensors.some((s) => s.status === 'connected'));
  const gpsOn = gps.kind === 'ok' || gps.kind === 'weak';
  const gpsKm = gpsOn ? (gps.distanceM / 1000).toFixed(2) : '—';

  async function handleStartRecording() {
    if (!canStartRecording) return;
    const deviceLabel =
      heartRate.kind === 'connected'
        ? heartRate.deviceName
        : (cyclingSensors.find((s) => s.status === 'connected')?.deviceName ??
          (gpsTrack.hasFix ? 'Phone GPS' : activityType));
    await askBatteryExemptionOnce(); // Android app, first recording only
    const header = await createRecording(deviceLabel, activityType);
    holdAwakeForRecording(); // released on Stop (MZY-280)
    recordingIdRef.current = header.id;
    gpsTrack.startRecording(header.id, header.startedAt);
    setRecording({
      kind: 'recording',
      recordingId: header.id,
      startedAt: header.startedAt,
      sampleCount: 0,
    });
  }

  async function handleStopRecording() {
    if (recording.kind !== 'recording') return;
    recordingIdRef.current = null;
    releaseRecordingWakeLock();
    await gpsTrack.stopRecording();
    await stopRecording(recording.recordingId);
    setRecording({ kind: 'idle' });
    await refreshUnflushed();
  }

  return (
    <main className="page">
      <header className="page-head">
        <Link href="/" className="back">
          ← Agon
        </Link>
        <h1>Record activity</h1>
        <p className="sub">
          Heart rate over Bluetooth for either activity; a ride also reads the
          Garmin Speed Sensor 2 / Cadence Sensor 2 over the standard BLE Cycling
          Speed and Cadence service, and any power meter on the standard Cycling
          Power service. In the Android app the phone’s GPS adds the route,
          distance and pace. Recordings buffer locally first, so a dropped
          connection never loses data.
        </p>
      </header>

      <div className="hr-actions" style={{ marginBottom: '1rem' }}>
        <button
          className={activityType === 'run' ? 'nt-btn' : 'nt-btn-ghost'}
          disabled={recording.kind !== 'idle'}
          onClick={() => setActivityType('run')}
        >
          Run
        </button>
        <button
          className={activityType === 'ride' ? 'nt-btn' : 'nt-btn-ghost'}
          disabled={recording.kind !== 'idle'}
          onClick={() => setActivityType('ride')}
        >
          Ride
        </button>
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="stat-value">
            {heartRate.kind === 'connected' ? (heartRate.bpm ?? '—') : '—'}
          </div>
          <div className="stat-label">bpm</div>
        </div>
        {activityType === 'ride' ? (
          <>
            <div className="stat">
              <div className="stat-value">
                {formatCyclingValue(cyclingSensors, 'speed', 1)}
              </div>
              <div className="stat-label">km/h</div>
            </div>
            <div className="stat">
              <div className="stat-value">
                {formatCyclingValue(cyclingSensors, 'cadence', 0)}
              </div>
              <div className="stat-label">rpm</div>
            </div>
            {gps.kind !== 'unsupported' && (
              <div className="stat">
                <div className="stat-value">{gpsKm}</div>
                <div className="stat-label">km (GPS)</div>
              </div>
            )}
            {cyclingSensors.some((s) => s.role === 'power') && (
              <div className="stat">
                <div className="stat-value">
                  {formatCyclingValue(cyclingSensors, 'power', 0)}
                </div>
                <div className="stat-label">W</div>
              </div>
            )}
          </>
        ) : gps.kind === 'unsupported' ? (
          <>
            <div className="stat">
              <div className="stat-value stat-value-placeholder">—</div>
              <div className="stat-label">pace (app only)</div>
            </div>
            <div className="stat">
              <div className="stat-value stat-value-placeholder">—</div>
              <div className="stat-label">distance (app only)</div>
            </div>
          </>
        ) : (
          <>
            <div className="stat">
              <div className="stat-value">
                {gpsOn ? formatPace(paceSecPerKm(gps.speedMps)) : '—'}
              </div>
              <div className="stat-label">min/km</div>
            </div>
            <div className="stat">
              <div className="stat-value">{gpsKm}</div>
              <div className="stat-label">km</div>
            </div>
          </>
        )}
      </div>

      {heartRate.kind === 'unsupported' && (
        <p className="muted" style={{ marginTop: '1rem' }}>
          Web Bluetooth isn’t supported in this browser. Try Chrome or Edge on
          Android, Windows, macOS, or Linux — it’s never available on iOS (Apple
          blocks it for every browser engine there).
        </p>
      )}

      {heartRate.kind === 'idle' && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <p className="muted small">
            Tap Connect, then pick your heart-rate strap from the device list.
          </p>
          <div className="hr-actions">
            <button className="nt-btn" onClick={handlePair}>
              Connect HR strap
            </button>
          </div>
        </div>
      )}

      {heartRate.kind === 'requesting' && (
        <p className="muted" style={{ marginTop: '1rem' }}>
          Waiting for a device to be selected…
        </p>
      )}

      {heartRate.kind === 'connecting' && (
        <p className="muted" style={{ marginTop: '1rem' }}>
          Connecting to {heartRate.deviceName}…
        </p>
      )}

      {heartRate.kind === 'connected' && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <p
            className={`hr-status${isStale(heartRate, nowTick) ? ' hr-status-stale' : ''}`}
          >
            {heartRate.deviceName} ·{' '}
            {heartRate.lastUpdatedAt == null
              ? 'waiting for first reading…'
              : isStale(heartRate, nowTick)
                ? `no update in ${Math.round((nowTick - heartRate.lastUpdatedAt) / 1000)}s — check contact`
                : `updated ${Math.round((nowTick - heartRate.lastUpdatedAt) / 1000)}s ago`}
          </p>
          <p className="hr-status">
            {sensorContactLabel(heartRate.sensorContact)}
          </p>
          <div className="hr-actions">
            <button className="nt-btn-ghost" onClick={handleDisconnect}>
              Disconnect HR strap
            </button>
          </div>
        </div>
      )}

      {heartRate.kind === 'disconnected' && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <p className="muted">
            Disconnected from {heartRate.deviceName}.
            {heartRate.lastBpm != null && (
              <>
                {' '}
                Last reading {heartRate.lastBpm} bpm
                {heartRate.lastUpdatedAt != null &&
                  ` (${Math.round((nowTick - heartRate.lastUpdatedAt) / 1000)}s ago)`}
                .
              </>
            )}
          </p>
          <div className="hr-actions">
            <button className="nt-btn" onClick={handleReconnect}>
              Reconnect
            </button>
            <button className="nt-btn-ghost" onClick={handlePair}>
              Pair a different strap
            </button>
          </div>
        </div>
      )}

      {heartRate.kind === 'error' && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <p className="hr-error">{heartRate.message}</p>
          <div className="hr-actions">
            <button className="nt-btn" onClick={handleTryAgain}>
              Try again
            </button>
            {heartRate.permissionDenied && getBleTransport().openSettings && (
              <button
                className="nt-btn-ghost"
                onClick={() => getBleTransport().openSettings?.()}
              >
                Open settings
              </button>
            )}
          </div>
        </div>
      )}

      <GpsCard
        gps={gps}
        onRetry={gpsTrack.retry}
        onOpenSettings={gpsTrack.openSettings}
      />

      <DeviceConflictAlert conflicts={deviceConflicts} />

      {activityType === 'ride' && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <p className="muted small">
            Pair the Speed Sensor and the Cadence Sensor separately — each is
            its own Bluetooth device, and this page tells them apart from what
            they report, not from their name. A power meter also gives cadence
            when no cadence sensor is paired.
          </p>
          <div className="hr-actions">
            <button className="nt-btn" onClick={handleConnectCyclingSensor}>
              Connect a cycling sensor
            </button>
            <button className="nt-btn-ghost" onClick={handleConnectPowerMeter}>
              Connect a power meter
            </button>
          </div>
          {cyclingSensors.map((s) => (
            <p key={s.id} className="hr-status" style={{ marginTop: '0.5rem' }}>
              {cyclingSensorLabel(s)} — {s.deviceName}
              {s.status === 'connected' && (
                <>
                  {' '}
                  <button
                    className="nt-btn-ghost"
                    onClick={() => handleDisconnectCyclingSensor(s.id)}
                  >
                    Disconnect
                  </button>
                </>
              )}
              {s.status === 'error' && s.errorMessage && (
                <span className="hr-error"> — {s.errorMessage}</span>
              )}
            </p>
          ))}
        </div>
      )}

      {(canStartRecording || recording.kind === 'recording') && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <div className="hr-actions">
            {recording.kind === 'idle' && (
              <button
                className="nt-btn"
                disabled={!canStartRecording}
                onClick={handleStartRecording}
              >
                Start recording
              </button>
            )}
            {recording.kind === 'recording' && (
              <button className="nt-btn" onClick={handleStopRecording}>
                Stop recording ({recording.sampleCount} samples)
              </button>
            )}
          </div>
        </div>
      )}

      {recording.kind === 'flushing' && (
        <p className="muted" style={{ marginTop: '1rem' }}>
          Saving recording…
        </p>
      )}
      {recording.kind === 'flushed' && (
        <p className="muted" style={{ marginTop: '1rem' }}>
          Saved as {recording.activityType} {recording.id}.
        </p>
      )}
      {flushError && (
        <p className="hr-error" style={{ marginTop: '1rem' }}>
          {flushError}
        </p>
      )}

      {unflushed.length > 0 && (
        <UnflushedRecordings
          recordings={unflushed}
          onFlushed={(activityType, id) => {
            setRecording({ kind: 'flushed', activityType, id });
            setFlushError(null);
            refreshUnflushed();
          }}
          onFlushError={(message) => setFlushError(message)}
          onDiscarded={() => refreshUnflushed()}
        />
      )}
    </main>
  );
}
