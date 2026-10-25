import {
  DEFAULT_DETECTION_PARAMS,
  DETECTION_PARAMS_BY_KIND,
  detectMissedStop,
  haversineM,
  type DetectionStream,
  type LatLng,
} from '@/lib/missedStopDetection';

// Synthetic geometry around a made-up home (not the athlete's). 1e-5° of
// latitude ≈ 1.11 m.
const HOME: LatLng = { lat: 50, lng: 10 };
const M_PER_DEG_LAT = 111_195;

interface Seg {
  secs: number;
  /** metres moved north per second (negative = south) */
  v: number;
  moving?: boolean;
}

/** 1 Hz stream starting `startM` metres south of home, moving along a meridian. */
function track(startM: number, segs: Seg[], flags = true): DetectionStream {
  const timeS = [0];
  const pos = [-startM];
  const distanceM = [0];
  const moving: boolean[] = [true];
  for (const s of segs) {
    for (let i = 0; i < s.secs; i++) {
      timeS.push(timeS.length);
      pos.push(pos[pos.length - 1]! + s.v);
      distanceM.push(distanceM[distanceM.length - 1]! + Math.abs(s.v));
      moving.push(s.moving ?? Math.abs(s.v) > 0.3);
    }
  }
  return {
    timeS,
    lat: pos.map((m) => HOME.lat + m / M_PER_DEG_LAT),
    lng: pos.map(() => HOME.lng),
    distanceM,
    moving: flags ? moving : null,
  };
}

describe('haversineM', () => {
  it('measures a known meridian distance', () => {
    expect(haversineM(HOME, { lat: 50.001, lng: 10 })).toBeCloseTo(111.2, 0);
  });
});

describe('detectMissedStop', () => {
  it('flags the 2026-09-29 ride-2 shape: ~3 min, 64 m, 26 s moving at home', () => {
    // ride home at 5.5 m/s, then 26 s walking the bike in at 1.5 m/s, then
    // 154 s of drift at ~0.16 m/s — 64 m in all, within ~40 m of home.
    const s = track(3000, [
      { secs: 545, v: 5.5 }, // arrives ~2.5 m short of home
      { secs: 26, v: 1.5, moving: true },
      { secs: 154, v: -0.16, moving: false },
    ]);
    const hit = detectMissedStop(s, HOME, DETECTION_PARAMS_BY_KIND.ride)!;
    expect(hit.confidence).toBe('home');
    expect(hit.trimS).toBeGreaterThanOrEqual(165);
    expect(hit.trimS).toBeLessThanOrEqual(185);
    expect(hit.distanceKm).toBeGreaterThan(0.03);
    expect(hit.distanceKm).toBeLessThan(0.08);
    expect(hit.movingS).toBeGreaterThan(0);
    expect(hit.cutAtS + hit.trimS).toBe(s.timeS[s.timeS.length - 1]);
  });

  it('with run params, the walk-in stays in (the cut lands after it)', () => {
    const s = track(3000, [
      { secs: 545, v: 5.5 },
      { secs: 26, v: 1.5, moving: true },
      { secs: 154, v: -0.16, moving: false },
    ]);
    const hit = detectMissedStop(s, HOME, DETECTION_PARAMS_BY_KIND.run)!;
    expect(hit.trimS).toBeLessThan(160);
    expect(hit.movingS).toBe(0);
  });

  it('does not flag a run that finishes at speed at the front door', () => {
    const s = track(5000, [
      { secs: 1667, v: 3 },
      { secs: 20, v: 0.1 },
    ]);
    expect(detectMissedStop(s, HOME)).toBeNull();
  });

  it('does not flag a genuine cool-down walk home', () => {
    // run finishes 600 m out, 7 min walk home at 1.4 m/s, stop on arrival
    const s = track(5600, [
      { secs: 1667, v: 3 },
      { secs: 420, v: 1.4 },
      { secs: 15, v: 0 },
    ]);
    expect(detectMissedStop(s, HOME)).toBeNull();
  });

  it('flags a slow tail away from home as low confidence', () => {
    // run ends 2 km from home, then 5 min pottering in a café (GPS drift)
    const s = track(7000, [
      { secs: 1667, v: 3 },
      { secs: 300, v: 0.1, moving: true },
    ]);
    const hit = detectMissedStop(s, HOME)!;
    expect(hit.confidence).toBe('away');
    expect(hit.trimS).toBeGreaterThanOrEqual(290);
    expect(hit.movingS).toBeGreaterThan(250);
  });

  it('works without a home (away-only) and without moving flags', () => {
    const s = track(
      3000,
      [
        { secs: 545, v: 5.5 },
        { secs: 180, v: 0.2 },
      ],
      false,
    );
    const hit = detectMissedStop(s, null)!;
    expect(hit.confidence).toBe('away');
    expect(hit.movingS).toBe(hit.trimS); // unflagged: every second counts
  });

  it('skips a no-impact tail (standing still, nothing moving-flagged)', () => {
    const s = track(3000, [
      { secs: 545, v: 5.5 },
      { secs: 120, v: 0, moving: false },
    ]);
    expect(detectMissedStop(s, HOME)).toBeNull();
  });

  it('tolerates GPS dropouts inside the tail', () => {
    const s = track(3000, [
      { secs: 545, v: 5.5 },
      { secs: 26, v: 2, moving: true },
      { secs: 154, v: -0.08, moving: false },
    ]);
    for (let i = 600; i < 620; i++) {
      s.lat[i] = null;
      s.lng[i] = null;
    }
    expect(detectMissedStop(s, HOME)?.confidence).toBe('home');
  });

  it('returns null without GPS', () => {
    const s = track(1000, [{ secs: 400, v: 3 }]);
    expect(
      detectMissedStop(
        { ...s, lat: s.lat.map(() => null), lng: s.lng.map(() => null) },
        HOME,
      ),
    ).toBeNull();
    expect(detectMissedStop({ ...s, lat: [], lng: [] }, HOME)).toBeNull();
  });

  it('respects a stricter minimum tail', () => {
    const s = track(3000, [
      { secs: 545, v: 5.5 },
      { secs: 26, v: 2, moving: true },
      { secs: 154, v: -0.08, moving: false },
    ]);
    expect(
      detectMissedStop(s, HOME, { ...DEFAULT_DETECTION_PARAMS, minTailS: 300 }),
    ).toBeNull();
  });

  describe('short stationary tails (rides)', () => {
    const RIDE = DETECTION_PARAMS_BY_KIND.ride;
    // Rides at 3 m/s to a spot short of home (away), then stands still.
    // flags=false: the live recorder stores no moving flags, so every tail
    // second counts as moving and the impact gate passes.
    const stood = (idleS: number, flags = false) =>
      track(
        3000,
        [
          { secs: 545, v: 3 },
          { secs: idleS, v: 0, moving: false },
        ],
        flags,
      );

    it('flags a 31 s standing tail on a ride, but not on a run', () => {
      const hit = detectMissedStop(stood(31), HOME, RIDE);
      expect(hit?.confidence).toBe('away');
      expect(hit?.trimS).toBeGreaterThanOrEqual(20);
      expect(hit?.trimS).toBeLessThan(60);
      expect(hit?.distanceKm).toBe(0);
      expect(
        detectMissedStop(stood(31), HOME, DETECTION_PARAMS_BY_KIND.run),
      ).toBeNull();
    });

    it('does not flag a brief stop (15 s)', () => {
      expect(detectMissedStop(stood(15), HOME, RIDE)).toBeNull();
    });

    it('does not shorten the bar for a tail that is still moving', () => {
      // 25 s at 0.5 m/s = 12.5 m: slow, but not stationary
      const s = track(3000, [
        { secs: 545, v: 3 },
        { secs: 25, v: 0.5, moving: true },
      ]);
      expect(detectMissedStop(s, HOME, RIDE)).toBeNull();
    });

    it('leaves the Strava-flagged standing tail alone (no totals to fix)', () => {
      expect(detectMissedStop(stood(31, true), HOME, RIDE)).toBeNull();
    });
  });
});
