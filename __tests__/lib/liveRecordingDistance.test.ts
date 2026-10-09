import {
  gpsDistanceM,
  resolveDistanceKm,
  wheelDistanceM,
} from '@/lib/liveRecordingDistance';

// Auto-derived distance for a live recording (MZY-282).

describe('wheelDistanceM', () => {
  it('multiplies the counter span by the circumference', () => {
    const speed = [
      { tMs: 1, wheelRevs: 1000, deviceId: 'spd' },
      { tMs: 2, wheelRevs: 1446, deviceId: 'spd' },
      { tMs: 3, wheelRevs: 1892, deviceId: 'spd' },
    ];
    // 892 revs × 2.242 m
    expect(wheelDistanceM(speed, 2242)).toBeCloseTo(1999.864, 3);
  });

  it('handles the uint32 counter rolling over', () => {
    const speed = [
      { tMs: 1, wheelRevs: 2 ** 32 - 10 },
      { tMs: 2, wheelRevs: 15 },
    ];
    expect(wheelDistanceM(speed, 2000)).toBeCloseTo(50, 6);
  });

  it('sums per device (a sensor swap mid-ride) and skips pre-MZY-282 samples', () => {
    const speed = [
      { tMs: 3, wheelRevs: 600, deviceId: 'b' },
      { tMs: 1, wheelRevs: 100, deviceId: 'a' },
      { tMs: 2, wheelRevs: 200, deviceId: 'a' },
      { tMs: 2.5, deviceId: 'a' },
      { tMs: 4, wheelRevs: 650, deviceId: 'b' },
    ];
    expect(wheelDistanceM(speed, 1000)).toBe(150);
  });

  it('is 0 with no counter values', () => {
    expect(wheelDistanceM([{ tMs: 1 }], 2242)).toBe(0);
  });
});

describe('resolveDistanceKm', () => {
  it('prefers a typed distance', () => {
    expect(
      resolveDistanceKm({ manualKm: 5.2, gpsM: 5012, wheelM: 4990 }),
    ).toEqual({ km: 5.2, source: 'manual' });
  });

  it('then GPS, then the wheel', () => {
    expect(resolveDistanceKm({ gpsM: 5012.37, wheelM: 4990 })).toEqual({
      km: 5.012,
      source: 'gps',
    });
    expect(resolveDistanceKm({ gpsM: 0.3, wheelM: 4990.6 })).toEqual({
      km: 4.991,
      source: 'wheel',
    });
  });

  it('is null when nothing rounds above 0 km (NUMERIC(7,3) CHECK > 0)', () => {
    expect(resolveDistanceKm({ gpsM: 0.4 })).toBeNull();
    expect(resolveDistanceKm({ manualKm: null })).toBeNull();
  });
});

it('gpsDistanceM is 0 for an empty track', () => {
  expect(gpsDistanceM([])).toBe(0);
});
