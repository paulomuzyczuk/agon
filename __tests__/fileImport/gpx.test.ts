import { parseGpx } from '@/services/fileImport/gpx';

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="StravaGPX Android" version="1.1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
 <metadata><time>2026-08-01T09:00:00Z</time></metadata>
 <trk>
  <name>Morning Run</name>
  <trkseg>
   <trkpt lat="52.5200" lon="13.4050">
     <ele>34.0</ele>
     <time>2026-08-01T09:00:00Z</time>
     <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>120</gpxtpx:hr><gpxtpx:cad>85</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions>
   </trkpt>
   <trkpt lat="52.5210" lon="13.4060">
     <ele>36.0</ele>
     <time>2026-08-01T09:00:10Z</time>
     <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>130</gpxtpx:hr><gpxtpx:cad>86</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions>
   </trkpt>
  </trkseg>
 </trk>
</gpx>`;

describe('parseGpx', () => {
  it('reads the creator from the <gpx> root (not the <?xml?> declaration)', () => {
    expect(parseGpx(GPX).creator).toBe('StravaGPX Android');
  });

  it('extracts trackpoints with lat/lon, elevation, time, and namespaced HR/cadence', () => {
    const { points } = parseGpx(GPX);
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({
      lat: 52.52,
      lng: 13.405,
      altitudeM: 34,
      heartrate: 120,
      cadence: 85,
      distanceM: null,
    });
    expect(points[0]!.timeMs).toBe(Date.parse('2026-08-01T09:00:00Z'));
    expect(points[1]!.heartrate).toBe(130);
  });

  it('reads the declared start from metadata <time>', () => {
    expect(parseGpx(GPX).declared.startTimeMs).toBe(
      Date.parse('2026-08-01T09:00:00Z'),
    );
  });

  it('does not bleed a later point’s fields into an earlier one', () => {
    const { points } = parseGpx(GPX);
    expect(points[0]!.heartrate).toBe(120); // not 130
  });

  it('returns an empty track for a GPX with no trackpoints', () => {
    const empty = `<?xml version="1.0"?><gpx creator="x"><trk></trk></gpx>`;
    expect(parseGpx(empty).points).toHaveLength(0);
  });
});
