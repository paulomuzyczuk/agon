// The recorder's BLE seam (MZY-275). app/record talks to sensors only through
// this interface, so the same pairing / primary-device / buffering code runs
// over Web Bluetooth in Chrome (lib/ble/webBluetooth.ts) and over native BLE
// inside the Capacitor Android shell, whose WebView has no Web Bluetooth
// (MZY-279). The frame parsers (lib/bluetooth*.ts) only ever see a DataView.
//
// A device is addressed by its transport id: Web Bluetooth's opaque
// BluetoothDevice.id (stable per site), or the native address. That id is the
// `deviceId` stamped on every buffered sample (MZY-271, lib/sourceDevices.ts).

/** The GATT services the recorder subscribes to — each to its Measurement characteristic. */
export type BleServiceKey = 'heart_rate' | 'csc' | 'cycling_power';

export interface BleDeviceRef {
  id: string;
  name: string | null;
}

export interface BleTransport {
  /** False when this runtime has no Bluetooth API at all (e.g. Safari, Firefox). */
  isAvailable(): boolean;
  /**
   * Shows the device picker filtered to `service`. Web Bluetooth only opens
   * it inside a user gesture, so implementations reach the picker
   * synchronously and callers must not `await` anything before calling this.
   * Rejects with BleCancelledError when the athlete dismisses the picker.
   */
  requestDevice(service: BleServiceKey): Promise<BleDeviceRef>;
  /**
   * Opens the GATT connection. `onDisconnected` fires on a link drop the
   * caller didn't ask for (out of range, strap off) — not on disconnect().
   */
  connect(device: BleDeviceRef, onDisconnected: () => void): Promise<void>;
  /** Enables notifications on the service's Measurement characteristic; resolves to an unsubscribe. */
  subscribe(
    device: BleDeviceRef,
    service: BleServiceKey,
    onFrame: (value: DataView) => void,
  ): Promise<() => Promise<void>>;
  /** Closes the connection. Never throws. */
  disconnect(device: BleDeviceRef): Promise<void>;
  /** Native only: opens the app's system settings (to grant a denied permission). */
  openSettings?(): Promise<void>;
}

/** The athlete dismissed the device picker — not an error worth showing. */
export class BleCancelledError extends Error {
  constructor() {
    super('Device selection cancelled');
    this.name = 'BleCancelledError';
  }
}

/** Bluetooth permission refused (Android "Nearby devices"). */
export class BlePermissionError extends Error {
  constructor(message = 'Bluetooth permission denied') {
    super(message);
    this.name = 'BlePermissionError';
  }
}

export function isCancelledPicker(err: unknown): boolean {
  return err instanceof BleCancelledError;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}
