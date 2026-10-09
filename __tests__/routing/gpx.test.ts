import { candidateToGpx } from '@/services/routing/gpx';
import type { RouteCandidate } from '@/services/routing/types';

// Pure GPX serializer — the watch artifact. Assert well-formed structure,
// elevation handling, and XML escaping.

function candidate(coordinates: number[][]): RouteCandidate {
  return {
    seed: 1,
    distanceM: 24130,
    elevationGainM: 267,
    coordinates,
    provider: 'openrouteservice',
  };
}

describe('candidateToGpx', () => {
  it('emits a GPX 1.1 track with a trkpt per coordinate + elevation', () => {
    const gpx = candidateToGpx(
      candidate([
        [13.3777, 52.5163, 42],
        [13.3781, 52.5169, 46],
      ]),
      { name: 'Agon 25 km loop #1' },
    );
    expect(gpx).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(gpx).toContain('<gpx version="1.1"');
    expect(gpx).toContain('http://www.topografix.com/GPX/1/1');
    expect(gpx).toContain('<name>Agon 25 km loop #1</name>');
    // lat/lon attributes in GPX order, ele inside the trkpt
    expect(gpx).toContain(
      '<trkpt lat="52.5163" lon="13.3777"><ele>42.0</ele></trkpt>',
    );
    expect(gpx.match(/<trkpt /g) ?? []).toHaveLength(2);
    expect(gpx.trimEnd().endsWith('</gpx>')).toBe(true);
  });

  it('omits <ele> when a coordinate has no altitude', () => {
    const gpx = candidateToGpx(candidate([[13.3777, 52.5163]]));
    expect(gpx).toContain('<trkpt lat="52.5163" lon="13.3777"></trkpt>');
    expect(gpx).not.toContain('<ele>');
  });

  it('escapes XML metacharacters in the name', () => {
    const gpx = candidateToGpx(candidate([[13.3551, 52.4269, 40]]), {
      name: 'Tom & "Jerry" <loop>',
    });
    expect(gpx).toContain('Tom &amp; &quot;Jerry&quot; &lt;loop&gt;');
    expect(gpx).not.toContain('Tom & "Jerry" <loop>');
  });
});
