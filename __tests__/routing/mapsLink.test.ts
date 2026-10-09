import {
  candidateToMapsUrl,
  downsample,
  selectWaypointIndices,
} from '@/services/routing/mapsLink';
import type { Coord, RouteCandidate } from '@/services/routing/types';

describe('downsample', () => {
  it('returns the array unchanged when short enough', () => {
    expect(downsample([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it('always includes first and last, evenly spaced', () => {
    const out = downsample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(10);
    expect(out).toHaveLength(3);
  });
});

function loop(n: number): RouteCandidate {
  // A closed loop: n interior points, first === last.
  const coords: number[][] = [[13.3551, 52.4269, 40]];
  for (let i = 1; i <= n; i++)
    coords.push([13.3551 + i * 0.001, 52.4269 + i * 0.001, 40]);
  coords.push([13.3551, 52.4269, 40]);
  return {
    seed: 1,
    distanceM: 25000,
    elevationGainM: 0,
    coordinates: coords,
    provider: 'test',
  };
}

describe('candidateToMapsUrl', () => {
  it('builds a walking directions URL with origin=destination (a loop)', () => {
    const url = candidateToMapsUrl(loop(20));
    expect(url).toContain('https://www.google.com/maps/dir/?api=1');
    expect(url).toContain('travelmode=walking');
    expect(url).toContain('origin=52.42690%2C13.35510');
    expect(url).toContain('destination=52.42690%2C13.35510');
  });

  it('caps intermediate waypoints under the Maps limit', () => {
    const url = candidateToMapsUrl(loop(200));
    const wp = new URL(url).searchParams.get('waypoints');
    expect(wp).not.toBeNull();
    // pipe-delimited; at most 8 via points
    expect(wp!.split('|').length).toBeLessThanOrEqual(8);
  });

  it('handles an empty geometry without throwing', () => {
    const url = candidateToMapsUrl({
      seed: 1,
      distanceM: 0,
      elevationGainM: null,
      coordinates: [],
      provider: 'test',
    });
    expect(url).toContain('/maps/dir/?api=1');
  });

  it('uses travelmode=bicycling for the cycling-regular profile', () => {
    const url = candidateToMapsUrl(loop(20), [], 'cycling-regular');
    expect(url).toContain('travelmode=bicycling');
  });

  it('defaults to travelmode=walking when no profile is given', () => {
    const url = candidateToMapsUrl(loop(20), []);
    expect(url).toContain('travelmode=walking');
  });
});

// A straight 21-interior-point route, so we know exactly which indices plain
// even-downsampling to 8 waypoints picks: [0,3,6,9,11,14,17,20] (verified below).
// Index 5 is deliberately NOT one of them — the case a through-waypoint landing
// there used to silently vanish from the Maps link (though never from the GPX).
function straightRoute(interiorLength: number): RouteCandidate {
  const coords: number[][] = [];
  for (let i = 0; i <= interiorLength + 1; i++) {
    coords.push([13.3551 + i * 0.001, 52.4269, 40]);
  }
  return {
    seed: 1,
    distanceM: 10000,
    elevationGainM: 0,
    coordinates: coords,
    provider: 'test',
  };
}

describe('selectWaypointIndices', () => {
  it('plain even-downsampling of the same geometry omits index 5 (baseline)', () => {
    const interior = straightRoute(21).coordinates.slice(1, -1);
    const viaIndices = downsample(interior, 8).map((c) => interior.indexOf(c));
    expect(viaIndices).toEqual([0, 3, 6, 9, 11, 14, 17, 20]);
    expect(viaIndices).not.toContain(5);
  });

  it('guarantees the index nearest each mustInclude point survives', () => {
    const interior = straightRoute(21).coordinates.slice(1, -1);
    const through: Coord = { lat: 52.4269, lng: interior[5]![0]! };
    const indices = selectWaypointIndices(interior, [through], 8);
    expect(indices).toHaveLength(8);
    expect(indices).toContain(5);
    expect(indices).toEqual([...indices].sort((a, b) => a - b)); // route order
  });

  it('caps at n even with more mustInclude points than slots', () => {
    const interior = straightRoute(21).coordinates.slice(1, -1);
    const through: Coord[] = [0, 4, 8, 12, 16, 20, 21, 25].map((i) => ({
      lat: 52.4269,
      lng: interior[Math.min(i, interior.length - 1)]![0]!,
    }));
    const indices = selectWaypointIndices(interior, through, 8);
    expect(indices.length).toBeLessThanOrEqual(8);
  });

  it('returns [] for empty interior geometry', () => {
    expect(selectWaypointIndices([], [{ lat: 52.4269, lng: 13.3551 }], 8)).toEqual(
      [],
    );
  });
});

describe('candidateToMapsUrl with mustInclude (constrained routes)', () => {
  it('includes a through-waypoint that the unconstrained selection would have dropped', () => {
    const candidate = straightRoute(21);
    const interior = candidate.coordinates.slice(1, -1);
    const fmt = (c: number[]) => `${c[1]!.toFixed(5)},${c[0]!.toFixed(5)}`;
    const waypointsWithout = (
      new URL(candidateToMapsUrl(candidate)).searchParams.get('waypoints') ?? ''
    ).split('|');
    // Any interior point the plain selection skipped (and not near the edges).
    const throughCoord = interior
      .slice(5, -5)
      .find((c) => !waypointsWithout.includes(fmt(c)))!;
    expect(throughCoord).toBeDefined();
    const through: Coord = { lat: throughCoord[1]!, lng: throughCoord[0]! };

    const waypointsWith = (
      new URL(candidateToMapsUrl(candidate, [through])).searchParams.get(
        'waypoints',
      ) ?? ''
    ).split('|');
    expect(waypointsWith).toContain(fmt(throughCoord));
  });

  it('the loop-only (no through/finish) path is unaffected — default mustInclude=[]', () => {
    expect(candidateToMapsUrl(loop(200))).toBe(
      candidateToMapsUrl(loop(200), []),
    );
  });
});

// A route whose geometry snaps back near the start before actually leaving —
// mirrors what ORS returns in practice (a start point followed by a next
// point a few metres away). Left unfiltered, that
// near-duplicate would consume one of the 8 Maps via slots as a redundant
// "stop" right next to the origin.
function routeWithNearStartDuplicate(): RouteCandidate {
  const coords: number[][] = [
    [13.377753, 52.516338, 42], // start
    [13.377706, 52.516338, 42], // ~3m away — near-duplicate of start
  ];
  for (let i = 1; i <= 20; i++) {
    coords.push([13.377753 + i * 0.002, 52.516338 + i * 0.002, 42]);
  }
  coords.push([13.377753, 52.516338, 42]); // close the loop
  return {
    seed: 1,
    distanceM: 25000,
    elevationGainM: 0,
    coordinates: coords,
    provider: 'test',
  };
}

describe('candidateToMapsUrl excludes near-start/end duplicate points', () => {
  it('drops a geometry point snapped near the start from the plain via list', () => {
    const url = candidateToMapsUrl(routeWithNearStartDuplicate());
    const waypoints = (new URL(url).searchParams.get('waypoints') ?? '').split(
      '|',
    );
    expect(waypoints).not.toContain('52.51634,13.37771');
  });

  it('drops it even when a mustInclude point is also given', () => {
    const candidate = routeWithNearStartDuplicate();
    const through: Coord = { lat: 52.526338, lng: 13.387753 }; // far interior point
    const url = candidateToMapsUrl(candidate, [through]);
    const waypoints = (new URL(url).searchParams.get('waypoints') ?? '').split(
      '|',
    );
    expect(waypoints).not.toContain('52.51634,13.37771');
  });
});

// A mostly-straight route east with one narrow out-and-back spur north at
// index 30–40 (apex at 35). A shortest-path router given evenly-spaced vias
// skips the spur entirely — the MZY-31 shortfall. Shape selection must pin it.
function routeWithSpur(): RouteCandidate {
  const coords: number[][] = [];
  for (let i = 0; i <= 70; i++) {
    const spur = i >= 30 && i <= 40 ? (5 - Math.abs(i - 35)) * 0.002 : 0;
    coords.push([13.3551 + i * 0.001, 52.4269 + spur, 40]);
  }
  return {
    seed: 1,
    distanceM: 7000,
    elevationGainM: 0,
    coordinates: coords,
    provider: 'test',
  };
}

describe('selectWaypointIndices shape selection (MZY-31)', () => {
  it('pins the apex of a detour that even spacing would miss', () => {
    const candidate = routeWithSpur();
    const coords = candidate.coordinates;
    const interior = coords.slice(1, -1);
    const apex = 34; // interior index of geometry index 35
    // Baseline: even spacing to 4 vias lands nowhere near the apex.
    expect(
      downsample(interior, 4).map((c) => interior.indexOf(c)),
    ).not.toContain(apex);
    const indices = selectWaypointIndices(
      interior,
      [],
      4,
      new Set(),
      coords[0],
      coords[coords.length - 1],
    );
    expect(indices).toContain(apex);
  });

  it('still spreads vias across a featureless straight line', () => {
    const interior = straightRoute(21).coordinates.slice(1, -1);
    const indices = selectWaypointIndices(interior, [], 4);
    expect(indices).toHaveLength(4);
    // No two picks adjacent: the widest-gap fallback splits the line up.
    for (let k = 1; k < indices.length; k++) {
      expect(indices[k]! - indices[k - 1]!).toBeGreaterThan(1);
    }
  });
});

describe('selectWaypointIndices excludeIndices', () => {
  it('skips excluded indices when filling remaining slots', () => {
    const interior = straightRoute(21).coordinates.slice(1, -1);
    const indices = selectWaypointIndices(interior, [], 8, new Set([0]));
    expect(indices).not.toContain(0);
    expect(indices).toHaveLength(8);
  });

  it('never drops a forced mustInclude index, even if it is also excluded', () => {
    const interior = straightRoute(21).coordinates.slice(1, -1);
    const through: Coord = { lat: 52.4269, lng: interior[0]![0]! };
    const indices = selectWaypointIndices(interior, [through], 8, new Set([0]));
    expect(indices).toContain(0);
  });
});
