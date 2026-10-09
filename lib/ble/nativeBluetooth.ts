// BleTransport over native Android BLE (MZY-279), used inside the Capacitor
// shell, whose WebView has no Web Bluetooth.
//
// Borrowed: @capacitor-community/bluetooth-le 8.3.0 — MIT (c) 2021 Capacitor
// plugin for Bluetooth Low Energy; used as a dependency, no source copied.
// See CREDITS.md.
//
// Device id = the plugin's deviceId, i.e. the sensor's Bluetooth address on
// Android. It is stable per strap, so it is a good `source_devices.ble_id`,
// but it differs from the same strap's Web Bluetooth id: a strap recorded in
// Chrome and in the app shows up under two ids (only ever one per recording).
//
// The Garmin HRM 200 must still be in open mode (3 green flashes) — see
// .claude/rules/live-recording.md.

import { BleClient } from '@capacitor-community/bluetooth-le';
import { GATT, uuid16To128 } from './gatt';
import {
  BleCancelledError,
  BlePermissionError,
  type BleDeviceRef,
  type BleServiceKey,
  type BleTransport,
} from './transport';

const service128 = (s: BleServiceKey) => uuid16To128(GATT[s].service16);
const characteristic128 = (s: BleServiceKey) =>
  uuid16To128(GATT[s].characteristic16);

/** Maps the plugin's string rejections onto the transport's typed errors. */
export function mapNativeError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/requestDevice cancelled/i.test(message)) return new BleCancelledError();
  if (/permission denied/i.test(message)) {
    return new BlePermissionError(
      'Bluetooth permission denied. Allow "Nearby devices" for Agon in Android Settings → Apps → Agon → Permissions.',
    );
  }
  return err instanceof Error ? err : new Error(message);
}

export function createNativeBluetoothTransport(): BleTransport {
  let initialized = false;
  /** Devices we're disconnecting on purpose — their disconnect callback is not a drop. */
  const intentional = new Set<string>();

  async function ensureReady() {
    if (!initialized) {
      // Asks for BLUETOOTH_SCAN/CONNECT (Android 12+). Only success is cached,
      // so a denied prompt is asked again on the next tap.
      await BleClient.initialize({ androidNeverForLocation: true });
      initialized = true;
    }
    if (!(await BleClient.isEnabled())) {
      throw new Error('Bluetooth is off. Turn it on and try again.');
    }
  }

  return {
    isAvailable: () => true,

    async requestDevice(service) {
      try {
        await ensureReady();
        const device = await BleClient.requestDevice({
          services: [service128(service)],
        });
        return { id: device.deviceId, name: device.name ?? null };
      } catch (err) {
        throw mapNativeError(err);
      }
    },

    async connect(ref: BleDeviceRef, onDisconnected) {
      intentional.delete(ref.id);
      try {
        await BleClient.connect(ref.id, () => {
          if (!intentional.has(ref.id)) onDisconnected();
        });
      } catch (err) {
        throw mapNativeError(err);
      }
    },

    async subscribe(ref, service, onFrame) {
      const s = service128(service);
      const c = characteristic128(service);
      await BleClient.startNotifications(ref.id, s, c, onFrame);
      return async () => {
        await BleClient.stopNotifications(ref.id, s, c).catch(() => {});
      };
    },

    async disconnect(ref) {
      intentional.add(ref.id);
      await BleClient.disconnect(ref.id).catch(() => {});
    },

    openSettings: () => BleClient.openAppSettings(),
  };
}
