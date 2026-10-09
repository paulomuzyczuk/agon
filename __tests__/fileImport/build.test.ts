import {
  buildRun,
  computeExternalId,
  detectFormat,
  inferSource,
  FileImportError,
} from '@/services/fileImport/build';
import { parseGpx } from '@/services/fileImport/gpx';

const GPX = `<?xml version="1.0"?>
<gpx creator="StravaGPX Android" xmlns:gpxtpx="x">
 <trk><trkseg>
  <trkpt lat="52.5200" lon="13.4050"><time>2026-08-01T09:00:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>120</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
  <trkpt lat="52.5210" lon="13.4060"><time>2026-08-01T09:10:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>140</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
 </trkseg></trk>
</gpx>`;

describe('detectFormat', () => {
  it('detects by extension', () => {
    expect(detectFormat('run.gpx', '')).toBe('gpx');
    expect(detectFormat('run.TCX', '')).toBe('tcx');
    expect(detectFormat('run.fit', '')).toBe('fit');
  });

  it('sniffs content for extension-less files', () => {
    expect(detectFormat('run', '<gpx creator="x">')).toBe('gpx');
    expect(detectFormat('run', '<TrainingCenterDatabase>')).toBe('tcx');
  });

  it('returns null for an unrecognised file', () => {
    expect(detectFormat('notes.txt', 'hello world')).toBeNull();
  });
});

describe('inferSource', () => {
  it('maps known creators to their source tag', () => {
    expect(inferSource('Garmin Connect')).toBe('garmin_export');
    expect(inferSource('StravaGPX Android')).toBe('strava_export');
    expect(inferSource('Samsung Health')).toBe('samsung_export');
  });

  it('returns null for an unknown/empty creator', () => {
    expect(inferSource('MysteryApp')).toBeNull();
    expect(inferSource(null)).toBeNull();
  });
});

describe('computeExternalId', () => {
  const m = { startTimeMs: 1000, distanceM: 5000, durationS: 1800 };

  it('is deterministic and file:-prefixed', () => {
    expect(computeExternalId(m)).toBe(computeExternalId({ ...m }));
    expect(computeExternalId(m)).toMatch(/^file:[0-9a-f]{16}$/);
  });

  it('differs when the activity identity differs', () => {
    expect(computeExternalId(m)).not.toBe(
      computeExternalId({ ...m, distanceM: 5001 }),
    );
  });
});

describe('buildRun', () => {
  it('maps a parsed GPX to a RunRecord under the given source', () => {
    const { run, streams, externalId } = buildRun(
      parseGpx(GPX),
      'strava_export',
    );
    expect(run.source).toBe('strava_export');
    expect(run.date).toBe('2026-08-01');
    expect(run.started_at).toBe('2026-08-01T09:00:00.000Z');
    expect(run.duration_s).toBe(600);
    expect(run.distance_km).toBeGreaterThan(0);
    expect(run.avg_hr).toBe(130);
    expect(run.max_hr).toBe(140);
    expect(run.origin).toBeNull();
    expect(run.strava_activity_id).toBeNull();
    expect(run.external_id).toBe(externalId);
    expect(streams!.timeS).toEqual([0, 600]);
  });

  it('throws FileImportError when the file has no usable run data', () => {
    const empty = parseGpx('<gpx creator="x"><trk></trk></gpx>');
    expect(() => buildRun(empty, 'strava_export')).toThrow(FileImportError);
  });
});
