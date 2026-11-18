import {
  parseTypedKm,
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

  it('then GPS, then the wheel, both to 2 decimals (10 m)', () => {
    expect(resolveDistanceKm({ gpsM: 5012.37, wheelM: 4990 })).toEqual({
      km: 5.01,
      source: 'gps',
    });
    expect(resolveDistanceKm({ gpsM: 0.3, wheelM: 4990.6 })).toEqual({
      km: 4.99,
      source: 'wheel',
    });
  });

  it('rounds half-up at the 5 m mark and never shows a third decimal', () => {
    expect(resolveDistanceKm({ gpsM: 9978.9 })).toEqual({
      km: 9.98, // the 10 km run whose GPS added up to 9.979 km
      source: 'gps',
    });
    expect(resolveDistanceKm({ gpsM: 5005 })?.km).toBe(5.01);
    expect(resolveDistanceKm({ gpsM: 5004.9 })?.km).toBe(5);
  });

  it('rounds a typed distance to 2 decimals too', () => {
    expect(resolveDistanceKm({ manualKm: 10.004 })).toEqual({
      km: 10,
      source: 'manual',
    });
    expect(resolveDistanceKm({ manualKm: 4.216 })?.km).toBe(4.22);
  });

  it('is null when nothing rounds above 0 km (distance_km CHECK > 0)', () => {
    expect(resolveDistanceKm({ gpsM: 4.9 })).toBeNull();
    expect(resolveDistanceKm({ manualKm: null })).toBeNull();
    // a typed 0.004 km rounds to 0: it does not count as typed, and with no
    // track behind it there is nothing to fall back to
    expect(resolveDistanceKm({ manualKm: 0.004 })).toBeNull();
  });
});

describe('parseTypedKm (the Save form field)', () => {
  it('empty means "derive it"', () => {
    expect(parseTypedKm(undefined)).toBeUndefined();
    expect(parseTypedKm('')).toBeUndefined();
    expect(parseTypedKm('  ')).toBeUndefined();
  });

  it('keeps at most 2 decimals', () => {
    expect(parseTypedKm('10')).toBe(10);
    expect(parseTypedKm(' 9.98 ')).toBe(9.98);
    expect(parseTypedKm('9.979')).toBe(9.98);
    expect(parseTypedKm('4.2149')).toBe(4.21);
  });

  it('rejects anything under 0.01 km or not a number', () => {
    expect(parseTypedKm('0')).toBe('invalid');
    expect(parseTypedKm('0.004')).toBe('invalid');
    expect(parseTypedKm('-3')).toBe('invalid');
    expect(parseTypedKm('abc')).toBe('invalid');
  });
});
