import { GATT } from './gatt';
import {
  BleCancelledError,
  type BleDeviceRef,
  type BleServiceKey,
  type BleTransport,
} from './transport';

// BleTransport over Web Bluetooth (MZY-275) — Chrome/Edge on desktop and
// Android. The connect/subscribe/cleanup sequence the recorder used before
// the transport seam, unchanged: gatt.connect → getPrimaryService →
// getCharacteristic → startNotifications, frames read off
// `characteristicvaluechanged`, link drops off `gattserverdisconnected`.

interface Entry {
  device: BluetoothDevice;
  server: BluetoothRemoteGATTServer | null;
  onDisconnected: (() => void) | null;
  /** Set by disconnect() so its own gattserverdisconnected isn't reported as a drop. */
  intentional: boolean;
}

export function createWebBluetoothTransport(): BleTransport {
  const entries = new Map<string, Entry>();

  function entryFor(ref: BleDeviceRef): Entry {
    const entry = entries.get(ref.id);
    if (!entry)
      throw new Error(`Unknown Bluetooth device ${ref.name ?? ref.id}`);
    return entry;
  }

  return {
    isAvailable: () =>
      typeof navigator !== 'undefined' && !!navigator.bluetooth,

    requestDevice(service: BleServiceKey) {
      if (!navigator.bluetooth) {
        return Promise.reject(
          new Error('Web Bluetooth is not supported in this browser.'),
        );
      }
      // Called synchronously from the click handler — Chrome rejects
      // requestDevice() outside a user gesture.
      return navigator.bluetooth
        .requestDevice({ filters: [{ services: [GATT[service].webService] }] })
        .then(
          (device) => {
            // Picking the same device again returns the same BluetoothDevice:
            // keep its entry so the drop listener is registered only once.
            if (!entries.has(device.id)) {
              const entry: Entry = {
                device,
                server: null,
                onDisconnected: null,
                intentional: false,
              };
              device.addEventListener('gattserverdisconnected', () => {
                if (!entry.intentional) entry.onDisconnected?.();
              });
              entries.set(device.id, entry);
            }
            return { id: device.id, name: device.name ?? null };
          },
          (err: unknown) => {
            // Chrome reports a dismissed chooser as NotFoundError.
            if (err instanceof Error && err.name === 'NotFoundError')
              throw new BleCancelledError();
            throw err;
          },
        );
    },

    async connect(ref, onDisconnected) {
      const entry = entryFor(ref);
      entry.intentional = false;
      entry.onDisconnected = onDisconnected;
      if (!entry.device.gatt) throw new Error('Device has no GATT server');
      entry.server = await entry.device.gatt.connect();
    },

    async subscribe(ref, service, onFrame) {
      const entry = entryFor(ref);
      if (!entry.server) throw new Error('Device is not connected');
      const gattService = await entry.server.getPrimaryService(
        GATT[service].webService,
      );
      const characteristic = await gattService.getCharacteristic(
        GATT[service].webCharacteristic,
      );
      const listener = (event: Event) => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (value) onFrame(value);
      };
      characteristic.addEventListener('characteristicvaluechanged', listener);
      await characteristic.startNotifications();
      return async () => {
        characteristic.removeEventListener(
          'characteristicvaluechanged',
          listener,
        );
        await characteristic.stopNotifications().catch(() => {});
      };
    },

    async disconnect(ref) {
      const entry = entries.get(ref.id);
      if (!entry) return;
      entry.intentional = true;
      // Unconditional: it also aborts a connect() still in flight.
      entry.device.gatt?.disconnect();
    },
  };
}
