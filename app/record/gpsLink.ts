import { createGpsTrack, MAX_ACCURACY_M } from '@/lib/gpsTrack';
import type { GpsSampleRecord } from '@/lib/liveRecordingDb';
import {
  GpsPermissionError,
  PHONE_GPS_DEVICE,
  type GpsFix,
  type GpsSource,
} from '@/lib/gps';

// The phone GPS's state machine for app/record (MZY-281), over any GpsSource.
// Plain TS like ./heartRateLink.ts, so it is unit-tested with a fake source
// (__tests__/record/gpsLink.test.ts); the page holds the React state.
//
// Two watchers:
//  - WARM-UP (foreground only, no notification) from page load, so a fix is
//    ready — and visible as "GPS ±4 m" — before Start;
//  - RECORDING (background: the plugin's foreground service + "Agon is
//    recording" notification), added on Start before the warm-up one is
//    removed, so there's no gap; both may deliver the same fix during the
//    hand-off, which the track filter drops as stale.
// Each fix the track filter (lib/gpsTrack.ts) accepts while recording is
// appended to IndexedDB, stamped as the phone GPS. Event-driven only — no
// timers on the sample path (screen-off WebView pause, live-recording.md).

export type GpsState =
  | { kind: 'unsupported' }
  | { kind: 'idle' }
  | { kind: 'acquiring' }
  | {
      kind: 'ok' | 'weak';
      accuracyM: number;
      /** Distance so far in this recording (m); 0 before Start. */
      distanceM: number;
      /** Current speed (m/s), null when unknown. */
      speedMps: number | null;
    }
  | { kind: 'error'; message: string; permissionDenied: boolean };

export interface GpsLinkDeps {
  source: GpsSource;
  setState: (next: GpsState) => void;
  appendGpsSample: (sample: GpsSampleRecord) => Promise<void>;
  /** A fix was buffered for `recordingId` (drives the Stop button's count). */
  onSample: (recordingId: string) => void;
}

export interface GpsLink {
  isAvailable(): boolean;
  /** Starts the warm-up watcher (asks for location permission the first time). */
  warmUp(): Promise<void>;
  /** After an error: restarts the warm-up watcher (asks for permission again). */
  retry(): Promise<void>;
  startRecording(recordingId: string, startedAt: number): Promise<void>;
  /** Ends the recording watcher and goes back to warming up. */
  stopRecording(): Promise<void>;
  openSettings(): void;
  /** Unmount cleanup: removes every watcher without touching state. */
  dispose(): void;
}

type Stop = () => Promise<void>;

export function createGpsLink(deps: GpsLinkDeps): GpsLink {
  const { source, setState } = deps;
  let warmStop: Stop | null = null;
  let recStop: Stop | null = null;
  let recording: {
    id: string;
    track: ReturnType<typeof createGpsTrack>;
  } | null = null;
  let distanceM = 0;
  let speedMps: number | null = null;
  // Bumped by dispose/stop so a watcher that resolves late is removed at once.
  let generation = 0;

  function onFix(fix: GpsFix) {
    if (!recording) {
      setState({
        kind: fix.accuracyM <= MAX_ACCURACY_M ? 'ok' : 'weak',
        accuracyM: fix.accuracyM,
        distanceM: 0,
        speedMps: fix.speedMps,
      });
      return;
    }
    const step = recording.track.push(fix);
    if (step.accepted) {
      distanceM = step.distanceM;
      speedMps = step.speedMps;
      deps
        .appendGpsSample({
          recordingId: recording.id,
          tMs: fix.tMs,
          lat: fix.lat,
          lng: fix.lng,
          altitudeM: fix.altitudeM,
          accuracyM: fix.accuracyM,
          speedMps: fix.speedMps,
          ...PHONE_GPS_DEVICE,
        })
        .catch(() => {});
      deps.onSample(recording.id);
    } else if (step.reason === 'stale') {
      return; // a duplicate from the other watcher during the hand-off
    }
    setState({
      kind: step.reason === 'inaccurate' ? 'weak' : 'ok',
      accuracyM: fix.accuracyM,
      distanceM,
      speedMps: step.accepted ? speedMps : null,
    });
  }

  function onError(err: Error) {
    setState({
      kind: 'error',
      message: err.message,
      permissionDenied: err instanceof GpsPermissionError,
    });
  }

  async function watch(background: boolean): Promise<Stop | null> {
    const gen = generation;
    try {
      const stop = await source.watch({ background }, onFix, onError);
      if (gen !== generation) {
        await stop();
        return null;
      }
      return stop;
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
      return null;
    }
  }

  async function stopWarmUp() {
    const stop = warmStop;
    warmStop = null;
    await stop?.();
  }

  async function warmUp() {
    if (!source.isAvailable()) {
      setState({ kind: 'unsupported' });
      return;
    }
    if (warmStop || recStop) return;
    setState({ kind: 'acquiring' });
    warmStop = await watch(false);
  }

  return {
    isAvailable: () => source.isAvailable(),
    warmUp,

    async retry() {
      if (recStop) return;
      await stopWarmUp();
      await warmUp();
    },

    async startRecording(recordingId, startedAt) {
      if (!source.isAvailable()) return;
      recording = { id: recordingId, track: createGpsTrack(startedAt) };
      distanceM = 0;
      speedMps = null;
      recStop = await watch(true);
      await stopWarmUp();
    },

    async stopRecording() {
      recording = null;
      generation += 1;
      const stop = recStop;
      recStop = null;
      await stop?.();
      await warmUp();
    },

    openSettings() {
      source.openSettings?.();
    },

    dispose() {
      generation += 1;
      recording = null;
      warmStop?.();
      recStop?.();
      warmStop = recStop = null;
    },
  };
}
