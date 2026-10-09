import {
  BLE_CSC_MEASUREMENT_CHARACTERISTIC,
  BLE_CSC_SERVICE,
  BLE_CYCLING_POWER_MEASUREMENT_CHARACTERISTIC,
  BLE_CYCLING_POWER_SERVICE,
  BLE_HEART_RATE_MEASUREMENT_CHARACTERISTIC,
  BLE_HEART_RATE_SERVICE,
} from '@/lib/constants';
import type { BleServiceKey } from './transport';

// Each recorder service in both spellings a transport needs: Web Bluetooth
// takes the Bluetooth SIG name strings (lib/constants.ts), native BLE the
// 16-bit assigned numbers, widened to 128-bit UUIDs by the native transport.

export interface GattEntry {
  webService: string;
  webCharacteristic: string;
  service16: number;
  characteristic16: number;
}

export const GATT: Record<BleServiceKey, GattEntry> = {
  heart_rate: {
    webService: BLE_HEART_RATE_SERVICE,
    webCharacteristic: BLE_HEART_RATE_MEASUREMENT_CHARACTERISTIC,
    service16: 0x180d,
    characteristic16: 0x2a37,
  },
  csc: {
    webService: BLE_CSC_SERVICE,
    webCharacteristic: BLE_CSC_MEASUREMENT_CHARACTERISTIC,
    service16: 0x1816,
    characteristic16: 0x2a5b,
  },
  cycling_power: {
    webService: BLE_CYCLING_POWER_SERVICE,
    webCharacteristic: BLE_CYCLING_POWER_MEASUREMENT_CHARACTERISTIC,
    service16: 0x1818,
    characteristic16: 0x2a63,
  },
};

/** A 16-bit assigned number on the Bluetooth Base UUID (0000xxxx-0000-1000-8000-00805f9b34fb). */
export function uuid16To128(n: number): string {
  return `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
}
