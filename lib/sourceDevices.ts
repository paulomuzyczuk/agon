// Per-data-point device provenance for live recordings (MZY-271). Pure, so the
// recorder (app/record, browser) and the flush (services/, server) share it,
// and it is unit-tested (__tests__/lib/sourceDevices.test.ts).
//
// Two jobs:
//  1. PRIMARY RULE — when several connected BLE devices report the same
//     metric, only the primary's samples are recorded: the earliest-paired
//     device still connected. For cadence, a dedicated CSC cadence sensor
//     outranks a power meter's crank cadence. A disconnect hands over to the
//     next one (a switchover, visible in the per-point index array).
//  2. INDEXING — turn samples carrying {deviceId, deviceName, deviceKind}
//     into the stored shape: a `source_devices` list + per-point indices into
//     it (migrations/20261006000000_stream_source_device.sql).

// 'gps' = the phone's own location provider in the Android app (MZY-281).
export type DeviceKind = 'heart_rate' | 'csc' | 'power' | 'gps';
export type StreamMetric = 'heartrate' | 'cadence' | 'velocity' | 'watts';

/** Optional device stamp on a buffered sample (absent on pre-MZY-271 data). */
export interface SampleDevice {
  deviceId?: string;
  deviceName?: string;
  deviceKind?: DeviceKind;
}

/** One entry of a stream row's `source_devices` (stored as JSONB). */
export interface SourceDevice {
  name: string;
  kind: DeviceKind;
  /** The transport's device id; for kind 'gps' the fixed 'phone-gps' (not BLE). */
  ble_id: string;
}

/** A device as the recorder sees it right now. */
export interface LiveSource {
  id: string;
  name: string;
  /** What the device measures: a CSC sensor is 'identifying' until its first frame. */
  role: 'heart_rate' | 'speed' | 'cadence' | 'power' | 'identifying';
  connected: boolean;
  /** Epoch ms of pairing — earlier wins. */
  pairedAt: number;
  /** Power meter only: it has sent crank (cadence) data. */
  reportsCadence?: boolean;
}

const METRIC_LABEL: Record<StreamMetric, string> = {
  heartrate: 'Heart rate',
  cadence: 'Cadence',
  velocity: 'Speed',
  watts: 'Power',
};

function supplies(s: LiveSource, metric: StreamMetric): boolean {
  switch (metric) {
    case 'heartrate':
      return s.role === 'heart_rate';
    case 'velocity':
      return s.role === 'speed';
    case 'watts':
      return s.role === 'power';
    case 'cadence':
      return s.role === 'cadence' || (s.role === 'power' && !!s.reportsCadence);
  }
}

/** Connected suppliers of a metric, primary first. */
function rankedSuppliers(
  metric: StreamMetric,
  sources: readonly LiveSource[],
): LiveSource[] {
  // Dedicated sensor before a power meter's secondary cadence, then pairing order.
  const tier = (s: LiveSource) =>
    metric === 'cadence' && s.role === 'power' ? 1 : 0;
  return sources
    .filter((s) => s.connected && supplies(s, metric))
    .sort((a, b) => tier(a) - tier(b) || a.pairedAt - b.pairedAt);
}

/** The device whose samples are recorded for `metric`, or null when none is connected. */
export function primaryDeviceFor(
  metric: StreamMetric,
  sources: readonly LiveSource[],
): string | null {
  return rankedSuppliers(metric, sources)[0]?.id ?? null;
}

export interface DeviceConflict {
  metric: StreamMetric;
  label: string;
  recorded: string;
  ignored: string[];
}

/** Every metric currently reported by more than one connected device. */
export function deviceConflicts(
  sources: readonly LiveSource[],
): DeviceConflict[] {
  const out: DeviceConflict[] = [];
  for (const metric of Object.keys(METRIC_LABEL) as StreamMetric[]) {
    const [primary, ...rest] = rankedSuppliers(metric, sources);
    if (primary && rest.length > 0) {
      out.push({
        metric,
        label: METRIC_LABEL[metric],
        recorded: primary.name,
        ignored: rest.map((s) => s.name),
      });
    }
  }
  return out;
}

/**
 * The `source_devices` list for a row, in order of first use (by sample
 * time across every metric), plus a lookup from device id to its index.
 * Samples without a device stamp are ignored (they map to a NULL index).
 */
export function buildDeviceIndex(
  samples: ReadonlyArray<SampleDevice & { tMs: number }>,
): {
  sourceDevices: SourceDevice[];
  indexOf: (deviceId?: string) => number | null;
} {
  const sourceDevices: SourceDevice[] = [];
  const index = new Map<string, number>();
  const stamped = samples
    .filter((s) => s.deviceId)
    .sort((a, b) => a.tMs - b.tMs);
  for (const s of stamped) {
    if (index.has(s.deviceId!)) continue;
    index.set(s.deviceId!, sourceDevices.length);
    sourceDevices.push({
      name: s.deviceName ?? 'unknown device',
      kind: s.deviceKind ?? 'csc',
      ble_id: s.deviceId!,
    });
  }
  return {
    sourceDevices,
    indexOf: (id) => (id != null ? (index.get(id) ?? null) : null),
  };
}

const KIND_LABEL: Record<DeviceKind, string> = {
  heart_rate: 'HR',
  csc: 'speed/cadence',
  power: 'power',
  gps: 'GPS',
};

/** "Garmin HRM 200 (HR) · Assioma Duo (power)", or null with no devices. */
export function formatSourceDevices(
  devices: readonly SourceDevice[] | null | undefined,
): string | null {
  if (!devices || devices.length === 0) return null;
  return devices.map((d) => `${d.name} (${KIND_LABEL[d.kind]})`).join(' · ');
}
