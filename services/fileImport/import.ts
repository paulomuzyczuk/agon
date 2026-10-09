import { readFile as fsReadFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { FileImportSource } from '../../lib/constants';
import { logger } from '../logger';
import type { RunRecord } from '../../lib/types';
import {
  classifyIncomingActivity,
  supersedeActivities,
} from '../activitySources';
import type {
  OverlapPartition,
  StoredActivity,
} from '../../lib/activitySourcePriority';
import {
  upsertRun as dbUpsertRun,
  type UpsertRunResult,
} from '../strava/ingest';
import {
  upsertRunStreams as dbUpsertRunStreams,
  type RunStreamData,
} from '../runStreams';
import { updateRunStartGps as dbUpdateRunStartGps } from '../runs';
import {
  buildRun,
  detectFormat,
  inferSource,
  parseActivity,
  FileImportError,
  type FileFormat,
} from './build';

// Orchestrates a single run-file import: read → detect → parse → build → apply
// the source priority (MZY-225) → upsert run + streams → merge any superseded
// Google Health twin into it. The generic, ungated
// fallback ingestion path (Workstream B) for Samsung Health / Garmin exports and
// Strava file exports. DB effects go through injectable deps so the decision flow
// is unit-testable without a database.

export interface OverlappingRun {
  id: string;
  source: string;
  startedAt: string | null;
}

export interface ImportRunFileOptions {
  /** Force the file-import source instead of inferring it from the file's creator. */
  source?: FileImportSource;
  /** Also write the run_streams time series + seed GPS start. Default true. */
  withStreams?: boolean;
  /**
   * Import even if an equal-or-higher-priority run (Agon recording, Strava,
   * another export) already overlaps this one — both rows are then kept.
   */
  force?: boolean;
}

export interface ImportRunFileDeps {
  readFile: (path: string) => Promise<string>;
  upsertRun: (r: RunRecord) => Promise<UpsertRunResult>;
  classifyOverlaps: (run: RunRecord) => Promise<OverlapPartition>;
  supersedeRuns: (
    winnerId: string,
    losers: StoredActivity[],
  ) => Promise<number>;
  upsertRunStreams: (
    runId: string,
    source: FileImportSource,
    data: RunStreamData,
  ) => Promise<void>;
  updateRunStartGps: (
    runId: string,
    lat: number | null,
    lng: number | null,
  ) => Promise<void>;
}

export type ImportStatus = 'inserted' | 'updated' | 'skipped-duplicate';

export interface ImportRunFileResult {
  status: ImportStatus;
  filePath: string;
  format: FileFormat;
  source: FileImportSource;
  externalId: string;
  runId: string | null;
  date: string;
  distanceKm: number;
  durationS: number;
  streamsWritten: boolean;
  /**
   * The equal-or-higher-priority run this import overlaps — set when skipped,
   * or when forced through.
   */
  conflict: OverlappingRun | null;
  /** Lower-priority (Google Health) twins merged into this import and removed. */
  superseded: number;
}

const defaultDeps: ImportRunFileDeps = {
  readFile: (path) => fsReadFile(path, 'utf8'),
  upsertRun: dbUpsertRun,
  classifyOverlaps: (run) => classifyIncomingActivity('run', run),
  supersedeRuns: (winnerId, losers) =>
    supersedeActivities('run', winnerId, losers),
  upsertRunStreams: dbUpsertRunStreams,
  updateRunStartGps: dbUpdateRunStartGps,
};

/**
 * Import one exported run file into public.runs (+ run_streams). Idempotent on
 * re-import (keyed on the deterministic file-hash external_id). Throws
 * FileImportError for a bad/empty/unsupported file; returns a skipped-duplicate
 * result (no write) when an equal-or-higher-priority run already overlaps and
 * `force` is off. A Google Health twin never blocks — it's superseded.
 */
export async function importRunFile(
  filePath: string,
  opts: ImportRunFileOptions = {},
  deps: ImportRunFileDeps = defaultDeps,
): Promise<ImportRunFileResult> {
  const withStreams = opts.withStreams ?? true;

  const content = await deps.readFile(filePath);
  const format = detectFormat(filePath, content);
  if (format === null) {
    throw new FileImportError(
      `unrecognised file '${basename(filePath)}' — expected a .gpx or .tcx export`,
    );
  }
  if (format === 'fit') {
    throw new FileImportError(
      `FIT is a binary format not yet decodable — re-export '${basename(filePath)}' ` +
        'as TCX or GPX (Garmin Connect and Strava both offer this) and retry',
    );
  }

  const parsed = parseActivity(format, content);
  const source = opts.source ?? inferSource(parsed.creator);
  if (!source) {
    throw new FileImportError(
      `could not infer the source from '${basename(filePath)}' ` +
        `(creator: ${parsed.creator ?? 'none'}) — pass --source ` +
        'samsung_export | garmin_export | strava_export',
    );
  }

  const built = buildRun(parsed, source);

  const overlap = await deps.classifyOverlaps(built.run);
  const blocker = overlap.blocking[0];
  const conflict: OverlappingRun | null = blocker
    ? {
        id: blocker.id,
        source: blocker.source,
        startedAt: new Date(blocker.startedAtMs)
          .toISOString()
          .replace(/\.\d{3}Z$/, 'Z'),
      }
    : null;

  const base = {
    filePath,
    format,
    source,
    externalId: built.externalId,
    date: built.run.date,
    distanceKm: built.run.distance_km,
    durationS: built.run.duration_s,
  } as const;

  if (conflict && !opts.force) {
    logger.warn('run file overlaps an existing run — skipping', {
      job: 'import-run-file',
      filePath,
      source,
      conflictRunId: conflict.id,
      conflictSource: conflict.source,
    });
    return {
      ...base,
      status: 'skipped-duplicate',
      runId: null,
      streamsWritten: false,
      conflict,
      superseded: 0,
    };
  }

  const { id: runId, status } = await deps.upsertRun(built.run);
  const superseded = await deps.supersedeRuns(runId, overlap.supersede);

  let streamsWritten = false;
  if (withStreams && built.streams) {
    await deps.upsertRunStreams(runId, source, built.streams);
    streamsWritten = true;
    await deps.updateRunStartGps(runId, built.startLat, built.startLng);
  }

  logger.info('imported run file', {
    job: 'import-run-file',
    filePath,
    source,
    runId,
    runStatus: status,
    streamsWritten,
    forcedOverConflict: conflict ? true : undefined,
    superseded,
  });

  return {
    ...base,
    status,
    runId,
    streamsWritten,
    conflict,
    superseded,
  };
}
