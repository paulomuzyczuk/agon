import { isNativeApp } from '@/lib/platform';
import { createNativeBluetoothTransport } from './nativeBluetooth';
import type { BleTransport } from './transport';
import { createWebBluetoothTransport } from './webBluetooth';

// The recorder's one BleTransport for this runtime: native BLE inside the
// Android shell (its WebView has no Web Bluetooth, MZY-279), Web Bluetooth in
// the browser (MZY-275). Chosen via lib/platform.ts, the single runtime check.

let transport: BleTransport | null = null;

export function getBleTransport(): BleTransport {
  transport ??= isNativeApp()
    ? createNativeBluetoothTransport()
    : createWebBluetoothTransport();
  return transport;
}

export * from './transport';
