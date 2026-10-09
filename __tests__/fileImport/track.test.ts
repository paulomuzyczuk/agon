import { haversineMeters } from '@/services/fileImport/geo';
import {
  alignPointsToStreams,
  resolveMetrics,
  type ParsedActivity,
  type TrackPoint,
} from '@/services/fileImport/track';

// Pure track math: no network, no DB.

const T0 = Date.parse('2026-08-01T09:00:00Z');

function pt(over: Partial<TrackPoint> = {}): TrackPoint {
  return {
    timeMs: null,
    lat: null,
    lng: null,
    altitudeM: null,
    heartrate: null,
    cadence: null,
    speedMps: null,
    distanceM: null,
    ...over,
  };
}

function activity(points: TrackPoint[], declared = {}): ParsedActivity {
  return {
    points,
    declared: {
      startTimeMs: null,
      totalTimeS: null,
      distanceM: null,
      ...declared,
    },
    creator: null,
  };
}

describe('haversineMeters', () => {
  it('is zero for identical points', () => {
    expect(haversineMeters(52.52, 13.405, 52.52, 13.405)).toBe(0);
  });

  it('~111 km per degree of longitude at the equator', () => {
    expect(haversineMeters(0, 0, 0, 1)).toBeCloseTo(111195, -2);
  });
});

describe('alignPointsToStreams', () => {
  it('rebases time to seconds and emits only present series', () => {
    const { streams, startLat, startLng } = alignPointsToStreams([
      pt({ timeMs: T0, lat: 52.52, lng: 13.405, heartrate: 120 }),
      pt({ timeMs: T0 + 10_000, lat: 52.521, lng: 13.406, heartrate: 130 }),
    ]);
    expect(streams!.timeS).toEqual([0, 10]);
    expect(streams!.heartrate).toEqual([120, 130]);
    expect(streams!.altitudeM).toBeNull(); // never measured
    expect(startLat).toBe(52.52);
    expect(startLng).toBe(13.405);
  });

  it('returns null streams when no point has a timestamp', () => {
    const { streams } = alignPointsToStreams([pt({ lat: 1, lng: 2 })]);
    expect(streams).toBeNull();
  });

  it('derives a cumulative distance stream via haversine when the file has no declared per-point distance (GPX)', () => {
    const { streams } = alignPointsToStreams([
      pt({ timeMs: T0, lat: 0, lng: 0 }),
      pt({ timeMs: T0 + 10_000, lat: 0, lng: 1 }), // ~111195 m east
      pt({ timeMs: T0 + 20_000, lat: 0, lng: 1 }), // no movement
    ]);
    expect(streams!.distanceM).not.toBeNull();
    expect(streams!.distanceM![0]).toBe(0);
    expect(streams!.distanceM![1]).toBeCloseTo(111195, -2);
    expect(streams!.distanceM![2]).toBeCloseTo(111195, -2); // unchanged, non-decreasing
  });

  it('prefers the file-declared cumulative distance (TCX) over haversine when present', () => {
    const { streams } = alignPointsToStreams([
      pt({ timeMs: T0, lat: 0, lng: 0, distanceM: 0 }),
      // A huge GPS jump that would haversine to ~111 km, but the file's own
      // declared distance (30 m) must win.
      pt({ timeMs: T0 + 10_000, lat: 0, lng: 1, distanceM: 30 }),
    ]);
    expect(streams!.distanceM).toEqual([0, 30]);
  });
});

describe('resolveMetrics', () => {
  it('prefers cumulative distance + timestamps, computes HR stats', () => {
    const m = resolveMetrics(
      activity([
        pt({ timeMs: T0, distanceM: 0, heartrate: 120 }),
        pt({ timeMs: T0 + 10_000, distanceM: 30, heartrate: 140 }),
        pt({ timeMs: T0 + 20_000, distanceM: 60, heartrate: 160 }),
      ]),
    );
    expect(m).not.toBeNull();
    expect(m!.startTimeMs).toBe(T0);
    expect(m!.durationS).toBe(20);
    expect(m!.distanceM).toBe(60);
    expect(m!.avgHr).toBe(140);
    expect(m!.maxHr).toBe(160);
  });

  it('measures distance from the GPS track when the file declares none', () => {
    const m = resolveMetrics(
      activity([
        pt({ timeMs: T0, lat: 0, lng: 0 }),
        pt({ timeMs: T0 + 60_000, lat: 0, lng: 0.001 }),
      ]),
    );
    expect(m!.distanceM).toBeCloseTo(111.2, 0);
    expect(m!.durationS).toBe(60);
  });

  it('sums only climbs above the noise floor for elevation gain', () => {
    const m = resolveMetrics(
      activity([
        pt({ timeMs: T0, distanceM: 0, altitudeM: 10 }),
        pt({ timeMs: T0 + 10_000, distanceM: 10, altitudeM: 12 }), // +2 counts
        pt({ timeMs: T0 + 20_000, distanceM: 20, altitudeM: 11 }), // -1 ignored
        pt({ timeMs: T0 + 30_000, distanceM: 30, altitudeM: 14 }), // +3 counts
      ]),
    );
    expect(m!.elevationGainM).toBe(5);
  });

  it('falls back to the declared summary when the track lacks timestamps', () => {
    const m = resolveMetrics(
      activity([pt({ distanceM: 5000 })], {
        startTimeMs: T0,
        totalTimeS: 1800,
      }),
    );
    expect(m).not.toBeNull();
    expect(m!.durationS).toBe(1800);
    expect(m!.distanceM).toBe(5000);
  });

  it('returns null when neither distance nor duration is resolvable', () => {
    expect(resolveMetrics(activity([pt({ heartrate: 120 })]))).toBeNull();
  });
});
