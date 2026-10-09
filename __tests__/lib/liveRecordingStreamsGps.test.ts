import { toRideStreamData, toRunStreamData } from '@/lib/liveRecordingStreams';

// GPS on the shared 1 s stream axis (MZY-282): route, cumulative distance,
// speed, provenance — with fractional, phone-like data.

const T0 = 1_760_000_000_000;
const LAT0 = 52.4731234;
const LNG0 = 13.4012345;
const GPS = {
  deviceId: 'phone-gps',
  deviceName: 'Phone GPS',
  deviceKind: 'gps' as const,
};
const r7 = (n: number) => Math.round(n * 1e7) / 1e7;

/** Northward at ~3.1 m/s, fixes 0.3 s after each whole second. */
const gpsFix = (s: number, altitudeM: number | null = 41.37) => ({
  tMs: T0 + s * 1000 + 300,
  lat: LAT0 + (s * 3.1) / 111_320,
  lng: LNG0,
  altitudeM,
  accuracyM: 3.8,
  speedMps: s === 2 ? null : 3.1234,
  ...GPS,
});
const strap = {
  deviceId: 'E8:44',
  deviceName: 'HRM 200',
  deviceKind: 'heart_rate' as const,
};

describe('toRunStreamData with GPS', () => {
  it('aligns 2 Hz HR and 1 Hz GPS onto one axis with the route series', () => {
    const hr = [0, 500, 1000, 1500, 2000, 2500, 3000].map((ms, i) => ({
      tMs: T0 + ms + 40,
      bpm: 130 + i,
      ...strap,
    }));
    const gps = [0, 1, 2, 4].map((s) => gpsFix(s));
    const out = toRunStreamData(hr, T0, gps);

    // 2 Hz HR no longer yields duplicate seconds (the later sample in a
    // second wins: 1040 ms beats 540 ms in second 1); second 4 is GPS-only.
    expect(out.timeS).toEqual([0, 1, 2, 3, 4]);
    expect(out.heartrate).toEqual([130, 132, 134, 136, null]);
    expect(out.lat).toEqual([
      LAT0,
      r7(LAT0 + 3.1 / 111_320),
      r7(LAT0 + 6.2 / 111_320),
      null,
      r7(LAT0 + 12.4 / 111_320),
    ]);
    expect(out.lng).toEqual([LNG0, LNG0, LNG0, null, LNG0]);
    expect(out.altitudeM).toEqual([41.4, 41.4, 41.4, null, 41.4]);
    expect(out.velocitySmoothMps).toEqual([3.12, 3.12, null, null, 3.12]);
    // Cumulative, forward-filled through the second without a fix.
    expect(out.distanceM![0]).toBe(0);
    expect(out.distanceM![3]).toBe(out.distanceM![2]);
    expect(out.distanceM![4]).toBeCloseTo(12.4, 0);
    expect(out.sourceDevices).toEqual([
      { name: 'HRM 200', kind: 'heart_rate', ble_id: 'E8:44' },
      { name: 'Phone GPS', kind: 'gps', ble_id: 'phone-gps' },
    ]);
    expect(out.heartrateSourceDevice).toEqual([0, 0, 0, 0, null]);
  });

  it('builds a GPS-only run: no HR series, no altitude when the phone gave none', () => {
    const out = toRunStreamData([], T0 - 2000, [
      gpsFix(0, null),
      gpsFix(1, null),
    ]);
    expect(out.timeS).toEqual([2, 3]);
    expect(out.heartrate).toBeUndefined();
    expect(out.altitudeM).toBeUndefined();
    expect(out.heartrateSourceDevice).toBeUndefined();
    expect(out.sourceDevices).toEqual([
      { name: 'Phone GPS', kind: 'gps', ble_id: 'phone-gps' },
    ]);
  });

  it('leaves distance null before the first fix', () => {
    const hr = [{ tMs: T0, bpm: 120 }];
    const out = toRunStreamData(hr, T0, [gpsFix(2)]);
    expect(out.timeS).toEqual([0, 2]);
    expect(out.distanceM).toEqual([null, 0]);
  });
});

describe('toRideStreamData with GPS', () => {
  const gps = [gpsFix(0), gpsFix(1)];

  it('takes speed from the wheel sensor when it reported', () => {
    const speed = [
      {
        tMs: T0 + 1000,
        speedKmh: 27,
        deviceId: 'SPD',
        deviceName: 'SPD',
        deviceKind: 'csc' as const,
      },
    ];
    const out = toRideStreamData({ hr: [], speed, cadence: [], gps }, T0);
    expect(out.velocitySmoothMps).toEqual([null, 7.5]);
    // Phone GPS was used first (second 0), so the sensor is index 1.
    expect(out.velocitySourceDevice).toEqual([null, 1]);
    expect(out.lat).toHaveLength(2);
  });

  it('falls back to the GPS speed, pointing velocity_source_device at the phone', () => {
    // 3 s apart = 9.3 m, past the 5 m jitter floor (1 s = 3.1 m isn't).
    const track = [gpsFix(0), gpsFix(3)];
    const out = toRideStreamData(
      { hr: [], speed: [], cadence: [], gps: track },
      T0,
    );
    expect(out.timeS).toEqual([0, 3]);
    expect(out.velocitySmoothMps).toEqual([3.12, 3.12]);
    expect(out.velocitySourceDevice).toEqual([0, 0]);
    expect(out.distanceM![1]).toBeCloseTo(9.3, 0);
  });

  it('is unchanged for a ride without GPS (no route series)', () => {
    const out = toRideStreamData(
      { hr: [{ tMs: T0, bpm: 120 }], speed: [], cadence: [] },
      T0,
    );
    expect(out).toEqual({ timeS: [0], heartrate: [120] });
  });
});
