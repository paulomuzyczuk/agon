import { createHash } from 'node:crypto';
import {
  DATA_SOURCES,
  isFileImportSource,
  type FileImportSource,
} from '../../lib/constants';
import { getAthleteProfile } from '../../lib/athleteProfile';
import { computeBlockWeek } from '../../lib/training/trainingBlocks';
import { athleteLocalParts } from '../../lib/time';
import type { RunRecord } from '../../lib/types';
import type { RunStreamData } from '../runStreams';
import { parseGpx } from './gpx';
import { parseTcx } from './tcx';
import {
  alignPointsToStreams,
  resolveMetrics,
  type ParsedActivity,
} from './track';

// Turn a parsed export file into a RunRecord + run_streams series. Pure (no I/O),
// so parsing/mapping is unit-testable and the orchestrator (import.ts) only owns
// the DB writes.

export type FileFormat = 'gpx' | 'tcx' | 'fit';

/** A user-facing error: the file can't be imported and why. */
export class FileImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileImportError';
  }
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Detect the export format from the filename extension, falling back to sniffing
 * the content. Returns 'fit' for FIT files (binary — not yet decodable; the
 * orchestrator raises a clear "export as TCX/GPX" error) and null when nothing
 * matches.
 */
export function detectFormat(
  filePath: string,
  content: string,
): FileFormat | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.gpx')) return 'gpx';
  if (lower.endsWith('.tcx')) return 'tcx';
  if (lower.endsWith('.fit')) return 'fit';
  // Content sniff for extension-less files.
  if (/<TrainingCenterDatabase\b/i.test(content)) return 'tcx';
  if (/<gpx\b/i.test(content)) return 'gpx';
  // FIT files start with a header whose bytes 8..11 are the ASCII ".FIT".
  if (content.slice(8, 12) === '.FIT') return 'fit';
  return null;
}

/**
 * Infer the file-import source from the producer string (GPX creator= / TCX
 * Author). Returns null when unrecognised — the caller then requires an explicit
 * --source. Garmin and Strava stamp identifiable creators; Samsung Health rarely
 * does, so it usually needs the flag.
 */
export function inferSource(creator: string | null): FileImportSource | null {
  const c = (creator ?? '').toLowerCase();
  if (!c) return null;
  if (c.includes('garmin')) return DATA_SOURCES.GARMIN_EXPORT;
  if (c.includes('strava')) return DATA_SOURCES.STRAVA_EXPORT;
  if (c.includes('samsung') || c.includes('shealth')) {
    return DATA_SOURCES.SAMSUNG_EXPORT;
  }
  return null;
}

/** Parse raw file content of a known text format into a ParsedActivity. */
export function parseActivity(
  format: 'gpx' | 'tcx',
  content: string,
): ParsedActivity {
  return format === 'gpx' ? parseGpx(content) : parseTcx(content);
}

/**
 * Deterministic idempotency id for an imported run: a hash of its start instant,
 * distance, and duration. Stable across re-imports of the same file (same inputs
 * → same id, so upsertRun updates in place), and distinct for genuinely different
 * activities. A materially edited/re-trimmed export yields a new id, but the
 * time-overlap guard in import.ts still catches it as a duplicate of the original.
 */
export function computeExternalId(m: {
  startTimeMs: number;
  distanceM: number;
  durationS: number;
}): string {
  const key = `${m.startTimeMs}|${Math.round(m.distanceM)}|${Math.round(m.durationS)}`;
  return `file:${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
}

export interface BuiltRun {
  run: RunRecord;
  streams: RunStreamData | null;
  startLat: number | null;
  startLng: number | null;
  externalId: string;
}

/**
 * Map a parsed activity to a RunRecord (+ aligned streams and route start), under
 * the given file-import source. Throws FileImportError when the file lacks the
 * positive distance + duration the `runs` CHECK constraints require. Qualitative
 * and weather fields are left null (owned by the voice-note / Open-Meteo
 * pipelines); origin is null (file imports have no upstream-platform distinction).
 */
export function buildRun(
  parsed: ParsedActivity,
  source: FileImportSource,
): BuiltRun {
  if (!isFileImportSource(source)) {
    throw new FileImportError(`unsupported import source '${source}'`);
  }
  const metrics = resolveMetrics(parsed);
  if (!metrics) {
    throw new FileImportError(
      'file has no usable run data (need a positive distance and duration — ' +
        'a track with timestamps, or a TCX summary)',
    );
  }

  const startedAtISO = new Date(metrics.startTimeMs).toISOString();
  const date = athleteLocalParts(startedAtISO, getAthleteProfile().timeZone).date;
  const { block, week } = computeBlockWeek(date);
  const distanceKm = round(metrics.distanceM / 1000, 3);

  const { streams, startLat, startLng } = alignPointsToStreams(parsed.points);
  const externalId = computeExternalId(metrics);

  const run: RunRecord = {
    date,
    started_at: startedAtISO,
    start_lat: startLat,
    start_lng: startLng,
    block,
    week,
    distance_km: distanceKm,
    duration_s: metrics.durationS,
    avg_hr: metrics.avgHr,
    max_hr: metrics.maxHr,
    avg_pace_s_per_km:
      distanceKm > 0 ? round(metrics.durationS / distanceKm, 2) : null,
    elevation_gain_m: metrics.elevationGainM,
    shoe_used: null,
    fueling: null,
    perceived_effort: null,
    pain_location: null,
    pain_onset_km: null,
    general_notes: null,
    strava_activity_id: null,
    external_id: externalId,
    source,
    origin: null,
    temp_c: null,
    humidity_pct: null,
    wind_kph: null,
    weather_conditions: null,
  };

  return { run, streams, startLat, startLng, externalId };
}
