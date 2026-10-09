// Generic run-file importer (Workstream B) — the free, ungated fallback ingestion
// path for exported GPX/TCX files (Samsung Health, Garmin, Strava). See
// docs/run-ingestion-migration.md §5 and CLAUDE.md "Run Ingestion Pivot".

export {
  importRunFile,
  type ImportRunFileOptions,
  type ImportRunFileResult,
  type ImportRunFileDeps,
  type ImportStatus,
  type OverlappingRun,
} from './import';
export {
  buildRun,
  detectFormat,
  inferSource,
  parseActivity,
  computeExternalId,
  FileImportError,
  type FileFormat,
  type BuiltRun,
} from './build';
export { parseGpx } from './gpx';
export { parseTcx } from './tcx';
export {
  alignPointsToStreams,
  resolveMetrics,
  type ParsedActivity,
  type TrackPoint,
  type ActivityMetrics,
} from './track';
export { haversineMeters } from './geo';
