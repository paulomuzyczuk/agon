import {
  parseCscMeasurement,
  computeWheelSpeedKmh,
  computeCadenceRpm,
} from '@/lib/bluetoothCycling';
import { parseCyclingPowerMeasurement } from '@/lib/bluetoothPower';
import { MERIDA_SILEX_400 } from '@/lib/gear';
import type {
  CadenceSampleRecord,
  PowerSampleRecord,
  SpeedSampleRecord,
} from '@/lib/liveRecordingDb';
import {
  primaryDeviceFor,
  type DeviceKind,
  type LiveSource,
  type StreamMetric,
} from '@/lib/sourceDevices';
import {
  errorMessage,
  isCancelledPicker,
  type BleDeviceRef,
  type BleServiceKey,
  type BleTransport,
} from '@/lib/ble';

// The ride-only BLE sensors of app/record, over any BleTransport (MZY-275).
// Plain TS rather than a hook so the pairing, frame handling and primary-
// device rule are unit-tested with a fake transport
// (__tests__/record/cyclingSensorHub.test.ts); useCyclingSensors.ts wraps it.
//
// CSC (MZY-168): the Garmin Speed Sensor 2 / Cadence Sensor 2 are SEPARATE
// physical devices sharing the one Cycling Speed and Cadence service
// (0x1816) — "Connect a cycling sensor" is called once per physical sensor,
// and each connection's role (speed vs. cadence) is auto-detected from which
// Measurement fields it reports, per lib/bluetoothCycling.ts.
//
// Power (MZY-270): a power meter on the Cycling Power service (0x1818,
// lib/bluetoothPower.ts) is paired with its own button. Its watts are written
// to `power_samples` (DEVICE-measured). If it also reports crank data, that
// becomes cadence — but ONLY while no dedicated CSC cadence sensor is
// connected, so two sources never land in the same 1 s cadence bucket.
//
// Device provenance (MZY-271): every sample is stamped with the transport's
// device id, and when two connected devices report the same metric ONLY the
// primary's samples are written (lib/sourceDevices.ts primaryDeviceFor —
// earliest-paired still connected; a cadence sensor beats a power meter).
// Event-driven only: no timers on the sample path.
// See .claude/rules/live-recording.md.

export type CyclingSensorRole = 'speed' | 'cadence' | 'power' | 'identifying';

export interface CyclingSensorState {
  id: string; // transport device id
  deviceName: string;
  role: CyclingSensorRole;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  value: number | null; // last km/h (speed), rpm (cadence) or W (power)
  /** Epoch ms of pairing — the earliest connected device of a metric is primary. */
  pairedAt: number;
  /** Power meter only: cadence from its crank data, when it reports any. */
  cadence?: number | null;
  lastUpdatedAt: number | null;
  errorMessage?: string;
}

export type CyclingSensorKind = 'csc' | 'power';

interface CyclingSensorConn {
  device: BleDeviceRef;
  unsubscribe: (() => Promise<void>) | null;
  /** False after an unrequested link drop — the primary rule hands over. */
  connected: boolean;
  role: CyclingSensorRole;
  pairedAt: number;
  /** Power meter only: it has sent crank (cadence) data. */
  reportsCadence: boolean;
  prevWheel: {
    cumulativeWheelRevs: number;
    lastWheelEventTime1024: number;
  } | null;
  prevCrank: {
    cumulativeCrankRevs: number;
    lastCrankEventTime1024: number;
  } | null;
}

const KIND: Record<
  CyclingSensorKind,
  { service: BleServiceKey; deviceKind: DeviceKind; fallbackName: string }
> = {
  csc: { service: 'csc', deviceKind: 'csc', fallbackName: 'cycling sensor' },
  power: {
    service: 'cycling_power',
    deviceKind: 'power',
    fallbackName: 'power meter',
  },
};

/** Watts as stored: integer, clamped to the 0-3000 W the flush API accepts. */
const storedWatts = (w: number) => Math.min(3000, Math.max(0, Math.round(w)));

export interface CyclingSensorHubDeps {
  transport: BleTransport;
  setSensors: (
    update: (prev: CyclingSensorState[]) => CyclingSensorState[],
  ) => void;
  /** The active recording, or null — samples are buffered only while set. */
  getRecordingId: () => string | null;
  /** Picker/connect failures outside a single sensor's row. */
  onError: (message: string) => void;
  append: {
    speed: (s: SpeedSampleRecord) => Promise<void>;
    cadence: (s: CadenceSampleRecord) => Promise<void>;
    power: (s: PowerSampleRecord) => Promise<void>;
  };
  now?: () => number;
}

export interface CyclingSensorHub {
  /** Opens the picker — call straight from the click handler (user gesture). */
  connect(kind: CyclingSensorKind): void;
  disconnect(id: string): void;
  /** Unmount cleanup: closes every link without touching state. */
  dispose(): void;
}

export function createCyclingSensorHub(
  deps: CyclingSensorHubDeps,
): CyclingSensorHub {
  const { transport, setSensors, getRecordingId, append } = deps;
  const now = deps.now ?? Date.now;
  const conns = new Map<string, CyclingSensorConn>();

  function patch(id: string, p: Partial<CyclingSensorState>) {
    setSensors((prev) => prev.map((s) => (s.id === id ? { ...s, ...p } : s)));
  }

  /** Whether `id` is the device whose `metric` samples are recorded right now. */
  function isPrimary(metric: StreamMetric, id: string): boolean {
    const sources: LiveSource[] = [...conns.entries()].map(([cid, c]) => ({
      id: cid,
      name: c.device.name ?? cid,
      role: c.role,
      connected: c.connected,
      pairedAt: c.pairedAt,
      reportsCadence: c.reportsCadence,
    }));
    return primaryDeviceFor(metric, sources) === id;
  }

  /** The device stamp every sample from `conn` carries. */
  function stamp(conn: CyclingSensorConn, kind: CyclingSensorKind) {
    return {
      deviceId: conn.device.id,
      deviceName: conn.device.name ?? KIND[kind].fallbackName,
      deviceKind: KIND[kind].deviceKind,
    };
  }

  /** Cadence from a crank reading (CSC or power meter), updating the conn's previous one. */
  function crankRpm(
    conn: CyclingSensorConn,
    revs: number | null,
    time1024: number | null,
  ): number | null {
    if (revs === null || time1024 === null) return null;
    const curr = {
      cumulativeCrankRevs: revs,
      lastCrankEventTime1024: time1024,
    };
    const prev = conn.prevCrank;
    conn.prevCrank = curr;
    return prev ? computeCadenceRpm(prev, curr) : null;
  }

  function onCscFrame(conn: CyclingSensorConn, value: DataView) {
    const id = conn.device.id;
    const reading = parseCscMeasurement(value);
    if (!reading) return;
    const t = now();
    const recordingId = getRecordingId();

    if (
      reading.cumulativeWheelRevs !== null &&
      reading.lastWheelEventTime1024 !== null
    ) {
      const curr = {
        cumulativeWheelRevs: reading.cumulativeWheelRevs,
        lastWheelEventTime1024: reading.lastWheelEventTime1024,
      };
      const prev = conn.prevWheel;
      conn.prevWheel = curr;
      conn.role = 'speed';
      const wheelCircumferenceMm = MERIDA_SILEX_400.wheelCircumferenceMm;
      const speedKmh =
        prev && wheelCircumferenceMm != null
          ? computeWheelSpeedKmh(prev, curr, wheelCircumferenceMm)
          : null;
      patch(id, {
        role: 'speed',
        status: 'connected',
        ...(speedKmh !== null ? { value: speedKmh, lastUpdatedAt: t } : {}),
      });
      if (speedKmh !== null && recordingId && isPrimary('velocity', id)) {
        append
          .speed({
            recordingId,
            tMs: t,
            speedKmh,
            wheelRevs: curr.cumulativeWheelRevs, // distance fallback (MZY-282)
            ...stamp(conn, 'csc'),
          })
          .catch(() => {});
      }
    } else if (
      reading.cumulativeCrankRevs !== null &&
      reading.lastCrankEventTime1024 !== null
    ) {
      conn.role = 'cadence';
      const rpm = crankRpm(
        conn,
        reading.cumulativeCrankRevs,
        reading.lastCrankEventTime1024,
      );
      patch(id, {
        role: 'cadence',
        status: 'connected',
        ...(rpm !== null ? { value: rpm, lastUpdatedAt: t } : {}),
      });
      if (rpm !== null && recordingId && isPrimary('cadence', id)) {
        append
          .cadence({ recordingId, tMs: t, rpm, ...stamp(conn, 'csc') })
          .catch(() => {});
      }
    }
  }

  function onPowerFrame(conn: CyclingSensorConn, value: DataView) {
    const id = conn.device.id;
    const reading = parseCyclingPowerMeasurement(value);
    if (!reading) return; // one bad frame — keep the prior reading displayed
    const t = now();
    const recordingId = getRecordingId();
    const watts = storedWatts(reading.instantaneousPowerW);
    const rpm = crankRpm(
      conn,
      reading.cumulativeCrankRevs,
      reading.lastCrankEventTime1024,
    );
    if (rpm !== null) conn.reportsCadence = true;
    patch(id, {
      status: 'connected',
      value: watts,
      lastUpdatedAt: t,
      ...(rpm !== null ? { cadence: rpm } : {}),
    });
    if (!recordingId) return;
    const device = stamp(conn, 'power');
    if (isPrimary('watts', id)) {
      append.power({ recordingId, tMs: t, watts, ...device }).catch(() => {});
    }
    if (rpm !== null && isPrimary('cadence', id)) {
      append.cadence({ recordingId, tMs: t, rpm, ...device }).catch(() => {});
    }
  }

  function close(id: string) {
    const conn = conns.get(id);
    if (!conn) return;
    conn.unsubscribe?.();
    transport.disconnect(conn.device);
    conns.delete(id);
  }

  async function subscribe(
    device: BleDeviceRef,
    kind: CyclingSensorKind,
    pairedAt: number,
  ) {
    const id = device.id;
    // Re-pairing the same sensor replaces its old subscription. The link
    // itself stays up (connect() on a connected device is a no-op), so no
    // late disconnect event can mark the new one dropped.
    conns.get(id)?.unsubscribe?.();
    conns.delete(id);
    const conn: CyclingSensorConn = {
      device,
      unsubscribe: null,
      connected: true,
      role: kind === 'power' ? 'power' : 'identifying',
      pairedAt,
      reportsCadence: false,
      prevWheel: null,
      prevCrank: null,
    };
    try {
      await transport.connect(device, () => {
        conn.connected = false;
        patch(id, { status: 'disconnected' });
      });
      const onFrame = kind === 'power' ? onPowerFrame : onCscFrame;
      conn.unsubscribe = await transport.subscribe(
        device,
        KIND[kind].service,
        (v) => onFrame(conn, v),
      );
      conns.set(id, conn);
      patch(id, {
        status: 'connected',
        deviceName: device.name ?? KIND[kind].fallbackName,
      });
    } catch (err) {
      transport.disconnect(device);
      patch(id, { status: 'error', errorMessage: errorMessage(err) });
    }
  }

  return {
    connect(kind) {
      if (!transport.isAvailable()) {
        deps.onError('Web Bluetooth is not supported in this browser.');
        return;
      }
      transport
        .requestDevice(KIND[kind].service)
        .then((device) => {
          const id = device.id;
          const pairedAt = now();
          setSensors((prev) => [
            ...prev.filter((s) => s.id !== id),
            {
              id,
              deviceName: device.name ?? KIND[kind].fallbackName,
              role: kind === 'power' ? 'power' : 'identifying',
              status: 'connecting',
              value: null,
              pairedAt,
              lastUpdatedAt: null,
            },
          ]);
          return subscribe(device, kind, pairedAt);
        })
        .catch((err) => {
          if (isCancelledPicker(err)) return;
          deps.onError(errorMessage(err));
        });
    },

    disconnect(id) {
      close(id);
      setSensors((prev) => prev.filter((s) => s.id !== id));
    },

    dispose() {
      for (const id of [...conns.keys()]) close(id);
    },
  };
}
