import {
  importRunFile,
  FileImportError,
  type ImportRunFileDeps,
} from '@/services/fileImport';
import type { StoredActivity } from '@/lib/activitySourcePriority';
import type { RunRecord } from '@/lib/types';

// Orchestration flow with injected deps — no filesystem, no DB.

const GPX = `<?xml version="1.0"?>
<gpx creator="StravaGPX Android" xmlns:gpxtpx="x">
 <trk><trkseg>
  <trkpt lat="52.5200" lon="13.4050"><time>2026-08-01T09:00:00Z</time></trkpt>
  <trkpt lat="52.5210" lon="13.4060"><time>2026-08-01T09:10:00Z</time></trkpt>
 </trkseg></trk>
</gpx>`;

interface Spy {
  deps: ImportRunFileDeps;
  upserted: RunRecord[];
  streamsCalls: number;
  gpsCalls: number;
  superseded: { winnerId: string; losers: StoredActivity[] }[];
}

function makeDeps(over: Partial<ImportRunFileDeps> = {}): Spy {
  const spy: Spy = {
    upserted: [],
    streamsCalls: 0,
    gpsCalls: 0,
    superseded: [],
    deps: {
      readFile: async () => GPX,
      upsertRun: async (r) => {
        spy.upserted.push(r);
        return { id: 'run-1', status: 'inserted' as const };
      },
      classifyOverlaps: async () => ({
        blocking: [],
        supersede: [],
        ambiguous: [],
      }),
      supersedeRuns: async (winnerId, losers) => {
        spy.superseded.push({ winnerId, losers });
        return losers.length;
      },
      upsertRunStreams: async () => {
        spy.streamsCalls++;
      },
      updateRunStartGps: async () => {
        spy.gpsCalls++;
      },
      ...over,
    },
  };
  return spy;
}

describe('importRunFile', () => {
  it('infers the source from the file creator and writes run + streams', async () => {
    const spy = makeDeps();
    const r = await importRunFile('run.gpx', {}, spy.deps);
    expect(r.status).toBe('inserted');
    expect(r.source).toBe('strava_export');
    expect(r.runId).toBe('run-1');
    expect(r.streamsWritten).toBe(true);
    expect(spy.upserted[0]!.source).toBe('strava_export');
    expect(spy.streamsCalls).toBe(1);
    expect(spy.gpsCalls).toBe(1);
  });

  it('honors an explicit --source over inference', async () => {
    const spy = makeDeps();
    const r = await importRunFile(
      'run.gpx',
      { source: 'samsung_export' },
      spy.deps,
    );
    expect(r.source).toBe('samsung_export');
    expect(spy.upserted[0]!.source).toBe('samsung_export');
  });

  const START = Date.parse('2026-08-01T09:00:00Z');
  const strava: StoredActivity = {
    id: 'st-9',
    source: 'strava',
    startedAtMs: START,
  };
  const gh: StoredActivity = {
    id: 'gh-9',
    source: 'google_health',
    startedAtMs: START,
  };
  const blockedBy = (b: StoredActivity) => async () => ({
    blocking: [b],
    supersede: [],
    ambiguous: [],
  });

  it('skips (no write) when an equal-or-higher-priority run overlaps and force is off', async () => {
    const spy = makeDeps({ classifyOverlaps: blockedBy(strava) });
    const r = await importRunFile('run.gpx', {}, spy.deps);
    expect(r.status).toBe('skipped-duplicate');
    expect(r.runId).toBeNull();
    expect(r.conflict).toEqual({
      id: 'st-9',
      source: 'strava',
      startedAt: '2026-08-01T09:00:00Z',
    });
    expect(spy.upserted).toHaveLength(0);
    expect(spy.superseded).toHaveLength(0);
  });

  it('imports through an overlap when force is set, surfacing the conflict', async () => {
    const spy = makeDeps({ classifyOverlaps: blockedBy(strava) });
    const r = await importRunFile('run.gpx', { force: true }, spy.deps);
    expect(r.status).toBe('inserted');
    expect(r.conflict?.id).toBe('st-9');
    expect(spy.upserted).toHaveLength(1);
  });

  it('supersedes a Google Health twin: writes the run, then merges the twin into it', async () => {
    const spy = makeDeps({
      classifyOverlaps: async () => ({
        blocking: [],
        supersede: [gh],
        ambiguous: [],
      }),
    });
    const r = await importRunFile('run.gpx', {}, spy.deps);
    expect(r.status).toBe('inserted');
    expect(r.conflict).toBeNull();
    expect(r.superseded).toBe(1);
    expect(spy.superseded).toEqual([{ winnerId: 'run-1', losers: [gh] }]);
  });

  it('skips streams with withStreams: false', async () => {
    const spy = makeDeps();
    const r = await importRunFile('run.gpx', { withStreams: false }, spy.deps);
    expect(r.streamsWritten).toBe(false);
    expect(spy.streamsCalls).toBe(0);
    expect(spy.gpsCalls).toBe(0);
  });

  it('rejects FIT files with a re-export hint', async () => {
    const spy = makeDeps({ readFile: async () => '' });
    await expect(importRunFile('run.fit', {}, spy.deps)).rejects.toThrow(
      /FIT is a binary format/,
    );
  });

  it('rejects an unrecognised file', async () => {
    const spy = makeDeps({ readFile: async () => 'hello' });
    await expect(importRunFile('notes.txt', {}, spy.deps)).rejects.toThrow(
      FileImportError,
    );
  });

  it('requires an explicit source when the creator is unknown', async () => {
    const noCreator = `<gpx><trk><trkseg>
      <trkpt lat="1" lon="2"><time>2026-08-01T09:00:00Z</time></trkpt>
      <trkpt lat="1.01" lon="2.01"><time>2026-08-01T09:10:00Z</time></trkpt>
    </trkseg></trk></gpx>`;
    const spy = makeDeps({ readFile: async () => noCreator });
    await expect(importRunFile('run.gpx', {}, spy.deps)).rejects.toThrow(
      /--source/,
    );
  });
});
