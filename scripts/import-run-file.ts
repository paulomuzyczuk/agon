import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import { postSyncMissedStops } from '../services/missedStops';
import {
  importRunFile,
  FileImportError,
  type ImportRunFileOptions,
} from '../services/fileImport';
import {
  FILE_IMPORT_SOURCES,
  isFileImportSource,
  type FileImportSource,
} from '../lib/constants';

// Generic GPX/TCX run-file importer (Phase 1 plumbing, Workstream B — the free,
// ungated fallback for Samsung Health / Garmin / Strava exports; see
// docs/run-ingestion-migration.md §5). Parses one or more exported files into
// public.runs (+ run_streams) with `source` set per file. Idempotent on re-import
// and guarded against duplicating a run that's already in the DB from another
// source (e.g. the live Google Health feed) — pass --force to override.
//
//   pnpm import:run <file.gpx|file.tcx> [more files...]
//     --source samsung_export|garmin_export|strava_export   (else inferred from the file)
//     --no-streams   skip the run_streams time series (metrics only)
//     --force        import even if a different run already overlaps in time
//
// Like the other ingestion jobs, it does NOT use the seed guard, so it can target
// the production database via DATABASE_URL.

interface ParsedArgs {
  files: string[];
  opts: ImportRunFileOptions;
}

function parseArgs(argv: string[]): ParsedArgs {
  const files: string[] = [];
  const opts: ImportRunFileOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--no-streams') {
      opts.withStreams = false;
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--source') {
      const value = argv[++i];
      if (!value || !isFileImportSource(value)) {
        throw new FileImportError(
          `--source must be one of: ${FILE_IMPORT_SOURCES.join(', ')}`,
        );
      }
      opts.source = value as FileImportSource;
    } else if (arg.startsWith('--source=')) {
      const value = arg.slice('--source='.length);
      if (!isFileImportSource(value)) {
        throw new FileImportError(
          `--source must be one of: ${FILE_IMPORT_SOURCES.join(', ')}`,
        );
      }
      opts.source = value as FileImportSource;
    } else if (arg.startsWith('--')) {
      throw new FileImportError(`unknown flag '${arg}'`);
    } else {
      files.push(arg);
    }
  }
  if (files.length === 0) {
    throw new FileImportError(
      'usage: pnpm import:run <file.gpx|file.tcx> [...] ' +
        '[--source ...] [--no-streams] [--force]',
    );
  }
  return { files, opts };
}

async function main(): Promise<void> {
  loadEnv();
  const { files, opts } = parseArgs(process.argv.slice(2));

  logger.info('starting run-file import', {
    job: 'import-run-file',
    fileCount: files.length,
    source: opts.source ?? '(inferred)',
    withStreams: opts.withStreams ?? true,
    force: opts.force ?? false,
  });

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    try {
      const r = await importRunFile(file, opts);
      if (r.status === 'skipped-duplicate') {
        skipped++;
        // eslint-disable-next-line no-console
        console.log(
          `- SKIP  ${file}\n        overlaps existing run ${r.conflict?.id} ` +
            `(source ${r.conflict?.source}, ${r.conflict?.startedAt ?? '?'}). ` +
            'Re-run with --force to import anyway.',
        );
        continue;
      }
      imported++;
      const km = r.distanceKm.toFixed(2);
      const mins = Math.round(r.durationS / 60);
      // eslint-disable-next-line no-console
      console.log(
        `+ ${r.status === 'inserted' ? 'ADD ' : 'UPD '} ${file}\n` +
          `        ${r.date} · ${km} km · ${mins} min · source ${r.source}` +
          `${r.streamsWritten ? ' · streams' : ''}` +
          `${r.conflict ? ` · forced over run ${r.conflict.id}` : ''}` +
          `${r.superseded ? ` · replaced ${r.superseded} Google Health twin(s)` : ''}`,
      );
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.log(`! FAIL  ${file}\n        ${msg}`);
      if (!(err instanceof FileImportError)) {
        logger.error(
          'run-file import errored',
          { job: 'import-run-file', file },
          err,
        );
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `\nDone: ${imported} imported, ${skipped} skipped (duplicate), ${failed} failed.\n`,
  );
  if (failed > 0) process.exitCode = 1;
  // Imported GPS tracks are the richest input for missed-stop detection
  // (MZY-254) — best-effort, never fails the import.
  if (imported > 0) await postSyncMissedStops();
}

main()
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(msg);
    logger.error('run-file import failed', { job: 'import-run-file' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
