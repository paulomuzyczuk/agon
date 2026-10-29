import {
  powerZoneBounds,
  zoneForWatts,
  timeInPowerZones,
  isUsableFtp,
  zoneBreakdown,
  POWER_ZONE_COUNT,
} from '@/lib/powerZones';

// Coggan power zones (MZY-63). An FTP of 200 W makes the percentages whole
// watts, so the expected bounds below are easy to check by hand.

describe('powerZoneBounds', () => {
  it('gives seven contiguous zones in watts for an FTP of 200', () => {
    const b = powerZoneBounds(200);
    expect(b).toHaveLength(POWER_ZONE_COUNT);
    expect(b.map((z) => [z.zone, z.minW, z.maxW])).toEqual([
      [1, 0, 110],
      [2, 111, 150],
      [3, 151, 180],
      [4, 181, 210],
      [5, 211, 240],
      [6, 241, 300],
      [7, 301, null],
    ]);
  });

  it('has no gap and no overlap for an awkward FTP either', () => {
    const b = powerZoneBounds(237);
    for (let i = 1; i < b.length; i++) {
      expect(b[i]!.minW).toBe((b[i - 1]!.maxW as number) + 1);
    }
    expect(b[0]!.minW).toBe(0);
    expect(b.at(-1)!.maxW).toBeNull();
  });

  it('names the zones', () => {
    expect(powerZoneBounds(250).map((z) => z.name)).toEqual([
      'Active recovery',
      'Endurance',
      'Tempo',
      'Threshold',
      'VO2 max',
      'Anaerobic capacity',
      'Neuromuscular',
    ]);
  });

  it.each([0, 49, 1001, NaN, -5])('rejects an unusable FTP (%p)', (ftp) => {
    expect(() => powerZoneBounds(ftp)).toThrow(/between 50 and 1000/);
  });
});

describe('zoneForWatts', () => {
  it.each([
    [0, 1],
    [110, 1],
    [111, 2],
    [150, 2],
    [151, 3],
    [180, 3],
    [181, 4],
    [210, 4],
    [211, 5],
    [240, 5],
    [241, 6],
    [300, 6],
    [301, 7],
    [1500, 7],
  ])('%p W at FTP 200 is zone %p', (w, zone) => {
    expect(zoneForWatts(w, 200)).toBe(zone);
  });

  it('counts a negative or glitchy value as 0 W', () => {
    expect(zoneForWatts(-40, 200)).toBe(1);
    expect(zoneForWatts(NaN, 200)).toBe(1);
  });

  it('agrees with the displayed bounds at every whole watt', () => {
    const bounds = powerZoneBounds(237);
    for (let w = 0; w <= 500; w++) {
      const z = bounds.find(
        (b) => w >= b.minW && (b.maxW === null || w <= b.maxW),
      );
      expect(zoneForWatts(w, 237)).toBe(z!.zone);
    }
  });
});

describe('timeInPowerZones', () => {
  it('counts seconds per zone and they add up to the ride', () => {
    const series = [0, 0, 100, 140, 140, 170, 200, 230, 280, 400];
    const z = timeInPowerZones(series, 200)!;
    expect(z).toEqual([3, 2, 1, 1, 1, 1, 1]);
    expect(z.reduce((a, b) => a + b, 0)).toBe(series.length);
  });

  it('counts coasting (0 W) as zone 1', () => {
    expect(timeInPowerZones([0, 0, 0], 250)).toEqual([3, 0, 0, 0, 0, 0, 0]);
  });

  it('is null without a usable FTP, like IF and TSS', () => {
    expect(timeInPowerZones([100, 200], null)).toBeNull();
    expect(timeInPowerZones([100, 200], 0)).toBeNull();
  });

  it('is all zeros for an empty series', () => {
    expect(timeInPowerZones([], 200)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('isUsableFtp', () => {
  it('matches the range the database allows', () => {
    expect(isUsableFtp(50)).toBe(true);
    expect(isUsableFtp(1000)).toBe(true);
    expect(isUsableFtp(49)).toBe(false);
    expect(isUsableFtp(null)).toBe(false);
    expect(isUsableFtp(undefined)).toBe(false);
  });
});

describe('zoneBreakdown', () => {
  it('joins watts bounds with seconds and shares', () => {
    const rows = zoneBreakdown(200, [600, 1800, 900, 300, 0, 0, 0])!;
    expect(rows).toHaveLength(7);
    expect(rows[1]).toMatchObject({
      zone: 2,
      name: 'Endurance',
      minW: 111,
      maxW: 150,
      seconds: 1800,
      pct: 50,
    });
    expect(rows.reduce((a, r) => a + r.pct, 0)).toBeCloseTo(100, 0);
  });

  it('is null without an FTP or with a malformed array', () => {
    expect(zoneBreakdown(null, [1, 1, 1, 1, 1, 1, 1])).toBeNull();
    expect(zoneBreakdown(200, null)).toBeNull();
    expect(zoneBreakdown(200, [1, 2, 3])).toBeNull();
  });

  it('shows 0 % everywhere for a zero-length ride rather than dividing by zero', () => {
    expect(
      zoneBreakdown(200, [0, 0, 0, 0, 0, 0, 0])!.every((r) => r.pct === 0),
    ).toBe(true);
  });
});
