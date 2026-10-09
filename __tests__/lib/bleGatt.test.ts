import { GATT, uuid16To128 } from '@/lib/ble/gatt';

// The recorder's GATT table (MZY-275): Web Bluetooth names + 16-bit numbers.

describe('ble gatt', () => {
  it('widens a 16-bit assigned number onto the Bluetooth Base UUID', () => {
    expect(uuid16To128(0x180d)).toBe('0000180d-0000-1000-8000-00805f9b34fb');
    expect(uuid16To128(0x2a5b)).toBe('00002a5b-0000-1000-8000-00805f9b34fb');
  });

  it('keeps the Web Bluetooth names the recorder used before the seam', () => {
    expect(GATT.heart_rate.webService).toBe('heart_rate');
    expect(GATT.heart_rate.webCharacteristic).toBe('heart_rate_measurement');
    expect(GATT.csc.webService).toBe('cycling_speed_and_cadence');
    expect(GATT.cycling_power.characteristic16).toBe(0x2a63);
  });
});
