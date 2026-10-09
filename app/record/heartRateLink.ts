import { parseHeartRateMeasurement } from '@/lib/bluetoothHeartRate';
import type { HrSampleRecord } from '@/lib/liveRecordingDb';
import {
  BlePermissionError,
  errorMessage,
  isCancelledPicker,
  type BleDeviceRef,
  type BleTransport,
} from '@/lib/ble';
import type { HeartRateState } from './heartRate';

// The HR strap's pairing/connection state machine for app/record, over any
// BleTransport (MZY-275). Plain TS rather than a hook so it is unit-tested
// with a fake transport (__tests__/record/heartRateLink.test.ts); the page
// owns the React state and passes its setter in as `setState`.
//
// Every parsed frame is appended to IndexedDB while a recording is active,
// stamped with the transport's device id (per-point provenance, MZY-271) —
// event-driven only, no timers on the sample path (screen-off WebView pause,
// .claude/rules/live-recording.md).

const FALLBACK_NAME = 'HR strap';

export interface HeartRateLinkDeps {
  transport: BleTransport;
  setState: (update: (prev: HeartRateState) => HeartRateState) => void;
  /** The active recording, or null — samples are buffered only while set. */
  getRecordingId: () => string | null;
  appendHrSample: (sample: HrSampleRecord) => Promise<void>;
  /** A sample was buffered for `recordingId` (drives the Stop button's count). */
  onSample: (recordingId: string) => void;
  now?: () => number;
}

export interface HeartRateLink {
  isAvailable(): boolean;
  /** Opens the picker — call straight from the click handler (user gesture). */
  pair(): void;
  reconnect(): void;
  disconnect(): void;
  /** Unmount cleanup: closes the link without touching state. */
  dispose(): void;
}

export function createHeartRateLink(deps: HeartRateLinkDeps): HeartRateLink {
  const { transport, setState, getRecordingId } = deps;
  const now = deps.now ?? Date.now;
  let device: BleDeviceRef | null = null;
  let unsubscribe: (() => Promise<void>) | null = null;

  const set = (next: HeartRateState) => setState(() => next);

  function onDrop() {
    setState((prev) =>
      prev.kind === 'connected'
        ? {
            kind: 'disconnected',
            deviceName: prev.deviceName,
            lastBpm: prev.bpm,
            lastUpdatedAt: prev.lastUpdatedAt,
          }
        : prev,
    );
  }

  function onFrame(dev: BleDeviceRef, value: DataView) {
    const reading = parseHeartRateMeasurement(value);
    if (!reading) return; // one bad frame — keep the prior reading displayed
    const t = now();
    setState((prev) =>
      prev.kind === 'connected'
        ? {
            ...prev,
            bpm: reading.bpm,
            lastUpdatedAt: t,
            sensorContact: reading.sensorContact,
          }
        : prev,
    );
    const recordingId = getRecordingId();
    if (!recordingId) return;
    deps
      .appendHrSample({
        recordingId,
        tMs: t,
        bpm: reading.bpm,
        sensorContact: reading.sensorContact,
        deviceId: dev.id, // per-point provenance (MZY-271)
        deviceName: dev.name ?? FALLBACK_NAME,
        deviceKind: 'heart_rate',
      })
      .catch(() => {});
    deps.onSample(recordingId);
  }

  async function connectTo(dev: BleDeviceRef) {
    const deviceName = dev.name ?? FALLBACK_NAME;
    set({ kind: 'connecting', deviceName });
    try {
      await transport.connect(dev, onDrop);
      unsubscribe = await transport.subscribe(dev, 'heart_rate', (v) =>
        onFrame(dev, v),
      );
      set({
        kind: 'connected',
        deviceName,
        bpm: null,
        lastUpdatedAt: null,
        sensorContact: 'not-supported',
      });
    } catch (err) {
      transport.disconnect(dev);
      set({ kind: 'error', message: errorMessage(err) });
    }
  }

  function close() {
    unsubscribe?.();
    unsubscribe = null;
    if (device) transport.disconnect(device);
  }

  return {
    isAvailable: () => transport.isAvailable(),

    pair() {
      if (!transport.isAvailable()) {
        set({ kind: 'unsupported' });
        return;
      }
      set({ kind: 'requesting' });
      transport
        .requestDevice('heart_rate')
        .then((dev) => {
          device = dev;
          return connectTo(dev);
        })
        .catch((err) => {
          set(
            isCancelledPicker(err)
              ? { kind: 'idle' }
              : {
                  kind: 'error',
                  message: errorMessage(err),
                  permissionDenied: err instanceof BlePermissionError,
                },
          );
        });
    },

    reconnect() {
      if (!device) {
        set({ kind: 'idle' });
        return;
      }
      connectTo(device);
    },

    disconnect() {
      close();
      set({ kind: 'idle' });
    },

    dispose: close,
  };
}
