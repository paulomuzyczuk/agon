import {
  createGpsTrack,
  cumulativeDistancesM,
  formatPace,
  paceSecPerKm,
  type TrackFix,
} from '@/lib/gpsTrack';
import { haversineMeters } from '@/lib/geo';

// GPS track maths for the live recorder (MZY-281): accept filter, jitter
// guard, live stats. Synthetic tracks around Tempelhofer Feld, Berlin, with
// fractional coordinates/accuracies like a real phone's.

const T0 = 1_760_000_000_000;
const LAT0 = 52.4731234;
const LNG0 = 13.4012345;
// Metres → degrees at this latitude.
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos((LAT0 * Math.PI) / 180);

/** A fix `north`/`east` metres from the origin, `s` seconds after T0. */
function fixAt(
  s: number,
  north: number,
  east = 0,
  extra: Partial<TrackFix> = {},
): TrackFix {
  return {
    tMs: T0 + s * 1000,
    lat: LAT0 + north / M_PER_DEG_LAT,
    lng: LNG0 + east / M_PER_DEG_LNG,
    accuracyM: 4.7,
    speedMps: null,
    ...extra,
  };
}

/** Running north at `mps` for `seconds`, one fix per second. */
function straightRun(seconds: number, mps: number): TrackFix[] {
  return Array.from({ length: seconds + 1 }, (_, s) =>
    fixAt(s, s * mps, 0, { speedMps: mps + 0.037 }),
  );
}

describe('createGpsTrack', () => {
  it('measures a straight 1 km run within 1%', () => {
    const track = createGpsTrack(T0);
    let last = 0;
    for (const f of straightRun(300, 3.3333)) last = track.push(f).distanceM;
    expect(last).toBeGreaterThan(990);
    expect(last).toBeLessThan(1010);
  });

  it('adds next to nothing while standing still with jitter', () => {
    const track = createGpsTrack(T0);
    let last = 0;
    // 10 min at rest, each fix wandering up to ±3.5 m (accuracy 4.7 m).
    for (let s = 0; s <= 600; s++) {
      const step = track.push(
        fixAt(s, 3.5 * Math.sin(s * 1.7), 3.5 * Math.cos(s * 2.3), {
          speedMps: 0.12,
        }),
      );
      expect(step.accepted).toBe(true);
      last = step.distanceM;
    }
    expect(last).toBeLessThan(25);
  });

  it('drops inaccurate, simulated, pre-start and duplicate fixes', () => {
    const track = createGpsTrack(T0);
    expect(track.push(fixAt(-2, 0)).reason).toBe('stale');
    expect(track.push(fixAt(0, 0, 0, { accuracyM: 30.4 })).reason).toBe(
      'inaccurate',
    );
    expect(track.push(fixAt(0, 0, 0, { simulated: true })).reason).toBe(
      'simulated',
    );
    expect(track.push(fixAt(0, 0)).accepted).toBe(true);
    expect(track.push(fixAt(0, 0)).reason).toBe('stale');
    expect(track.push(fixAt(1, 3.1, 0, { accuracyM: 29.9 })).accepted).toBe(
      true,
    );
  });

  it('rejects a single spike and keeps counting from the last good fix', () => {
    const track = createGpsTrack(T0);
    track.push(fixAt(0, 0));
    track.push(fixAt(1, 3));
    const spike = track.push(fixAt(2, 400)); // 397 m in 1 s
    expect(spike).toMatchObject({ accepted: false, reason: 'jump' });
    const next = track.push(fixAt(3, 9));
    expect(next.accepted).toBe(true);
    expect(next.distanceM).toBeCloseTo(9, 0);
  });

  it('re-anchors after 3 jumps in a row (the first fix was the outlier), adding no distance', () => {
    const track = createGpsTrack(T0);
    track.push(fixAt(0, 500)); // bad first fix, claims good accuracy
    expect(track.push(fixAt(1, 0)).reason).toBe('jump');
    expect(track.push(fixAt(2, 3)).reason).toBe('jump');
    const third = track.push(fixAt(3, 6));
    expect(third).toMatchObject({ accepted: true, distanceM: 0 });
    expect(track.push(fixAt(4, 12)).distanceM).toBeCloseTo(6, 0);
  });

  it("reports the fix's own speed, else the last segment's", () => {
    const track = createGpsTrack(T0);
    track.push(fixAt(0, 0));
    expect(track.push(fixAt(2, 7, 0, { speedMps: 3.61 })).speedMps).toBe(3.61);
    expect(track.push(fixAt(4, 14)).speedMps).toBeCloseTo(3.5, 1);
  });
});

describe('cumulativeDistancesM', () => {
  it('recounts an accepted track the same as the live filter did', () => {
    const live = createGpsTrack(T0);
    const accepted: TrackFix[] = [];
    const liveDistances: number[] = [];
    const raw = [
      fixAt(0, 500),
      fixAt(1, 0),
      fixAt(2, 3),
      fixAt(3, 6),
      ...straightRun(120, 2.9).map((f, i) => ({
        ...f,
        tMs: f.tMs + 4000,
        lat: f.lat + 6 / M_PER_DEG_LAT,
        accuracyM: 3 + (i % 5) * 0.8,
      })),
    ];
    for (const f of raw) {
      const step = live.push(f);
      if (step.accepted) {
        accepted.push(f);
        liveDistances.push(step.distanceM);
      }
    }
    expect(cumulativeDistancesM(accepted)).toEqual(liveDistances);
  });

  it('is monotonic and matches haversine on a curved route', () => {
    const fixes = Array.from({ length: 200 }, (_, s) => {
      const a = (s / 200) * Math.PI; // half circle, radius 150 m
      return fixAt(s, 150 * Math.sin(a), 150 - 150 * Math.cos(a));
    });
    const d = cumulativeDistancesM(fixes);
    for (let i = 1; i < d.length; i++)
      expect(d[i]).toBeGreaterThanOrEqual(d[i - 1]!);
    const arc = Math.PI * 150 * (199 / 200);
    expect(d.at(-1)!).toBeGreaterThan(arc * 0.97);
    expect(d.at(-1)!).toBeLessThanOrEqual(arc * 1.001);
  });
});

describe('pace', () => {
  it('converts speed to s/km and formats m:ss', () => {
    expect(paceSecPerKm(3.3333)).toBeCloseTo(300, 0);
    expect(formatPace(paceSecPerKm(3.0))).toBe('5:33');
    expect(formatPace(323.6)).toBe('5:24');
  });

  it('has no pace when standing or unknown', () => {
    expect(paceSecPerKm(0.3)).toBeNull();
    expect(paceSecPerKm(null)).toBeNull();
    expect(formatPace(null)).toBe('—');
  });
});

it('haversine sanity: 1° of latitude ≈ 111.2 km', () => {
  expect(haversineMeters(52, 13, 53, 13)).toBeCloseTo(111_195, -2);
});
