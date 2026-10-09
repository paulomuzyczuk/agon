import {
  BleCancelledError,
  type BleDeviceRef,
  type BleServiceKey,
  type BleTransport,
} from '@/lib/ble/transport';

// An in-memory BleTransport for the recorder's consumer tests (MZY-275): the
// test queues which device the "picker" returns, then pushes frames and
// link drops by hand.

export interface FakeBleTransport extends BleTransport {
  /** The next requestDevice() resolves to this device (or cancels, with null). */
  nextPick(device: BleDeviceRef | null): void;
  /** Delivers one notification frame to every subscriber of `deviceId`. */
  frame(deviceId: string, bytes: number[]): void;
  /** An unrequested link drop (strap out of range). */
  drop(deviceId: string): void;
  failConnect(deviceId: string, message: string): void;
  connected(deviceId: string): boolean;
  subscriberCount(deviceId: string): number;
  requested: BleServiceKey[];
}

export function createFakeBleTransport(available = true): FakeBleTransport {
  const picks: (BleDeviceRef | null)[] = [];
  const onDrop = new Map<string, () => void>();
  const subs = new Map<string, Set<(v: DataView) => void>>();
  const links = new Set<string>();
  const connectFailures = new Map<string, string>();
  const requested: BleServiceKey[] = [];

  return {
    requested,
    isAvailable: () => available,
    requestDevice(service) {
      requested.push(service);
      const pick = picks.shift();
      if (pick === undefined)
        return Promise.reject(new Error('no device queued'));
      return pick
        ? Promise.resolve(pick)
        : Promise.reject(new BleCancelledError());
    },
    async connect(device, onDisconnected) {
      const failure = connectFailures.get(device.id);
      if (failure) throw new Error(failure);
      links.add(device.id);
      onDrop.set(device.id, onDisconnected);
    },
    async subscribe(device, _service, onFrame) {
      const set = subs.get(device.id) ?? new Set();
      set.add(onFrame);
      subs.set(device.id, set);
      return async () => {
        set.delete(onFrame);
      };
    },
    async disconnect(device) {
      links.delete(device.id);
    },
    nextPick: (device) => picks.push(device),
    frame(deviceId, bytes) {
      const view = new DataView(new Uint8Array(bytes).buffer);
      for (const cb of subs.get(deviceId) ?? []) cb(view);
    },
    drop(deviceId) {
      links.delete(deviceId);
      onDrop.get(deviceId)?.();
    },
    failConnect: (deviceId, message) => connectFailures.set(deviceId, message),
    connected: (deviceId) => links.has(deviceId),
    subscriberCount: (deviceId) => subs.get(deviceId)?.size ?? 0,
  };
}

/** Lets pending promise callbacks (requestDevice → connect → subscribe) run. */
export const flush = () => new Promise((r) => setImmediate(r));

/** A React-style state cell for the consumers' functional setters. */
export function stateCell<T>(initial: T) {
  let value = initial;
  return {
    get: () => value,
    set: (update: (prev: T) => T) => {
      value = update(value);
    },
  };
}
