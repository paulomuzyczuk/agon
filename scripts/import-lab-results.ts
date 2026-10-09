import { loadEnv } from './loadEnv';
loadEnv();

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import { findOrCreateLabPanel, upsertLabResult, type LabResultInput } from '../services/labResults';
import {
  parseLabCsv,
  rowsNeedingReview,
  buildReviewSummary,
  DEFAULT_LAB_CONFIDENCE_THRESHOLD,
} from '../lib/labImport';

// Imports a flattened lab-test CSV into lab_panels/lab_panel_results.
// Idempotent: panels resolve on (date, panel_type) and results upsert on
// (lab_panel_id, marker), so re-running a corrected CSV overwrites in place
// rather than duplicating. The CSV is normally produced by the lab-ingestion
// skill (.claude/skills/lab-ingestion/SKILL.md) reading an uploaded PDF
// directly — mirrors sihha's scripts/import-lab-results.ts end to end (CSV
// interchange format, idempotent natural-key upsert, confidence/needs_review
// provenance) but goes through Agon's own plain-`pg` services/db.ts rather
// than @supabase/supabase-js, and reports low-confidence rows to stdout for
// the invoking session to relay instead of e-mailing an admin (Agon is
// single-user with no alerting-ledger layer).
//
// CSV columns: see lib/labImport.ts LAB_CSV_HEADER.
//
// Usage:
//   pnpm import:labs path/to/report.csv [--model <extractor model id>]
// Threshold: AGON_LAB_OCR_CONFIDENCE_MIN (0-1, default 0.85).

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? (process.argv[index + 1] ?? null) : null;
}

function confidenceThreshold(): number {
  const env = Number(process.env.AGON_LAB_OCR_CONFIDENCE_MIN);
  return Number.isFinite(env) && env > 0 && env <= 1 ? env : DEFAULT_LAB_CONFIDENCE_THRESHOLD;
}

async function main(): Promise<void> {
  const csvPath = process.argv[2];
  if (!csvPath || csvPath.startsWith('--')) {
    console.error('Usage: pnpm import:labs <path-to-csv> [--model <extractor model id>]');
    process.exit(1);
  }
  const model = argValue('--model');

  const rows = parseLabCsv(readFileSync(resolve(process.cwd(), csvPath), 'utf-8'));
  const threshold = confidenceThreshold();
  const lowKeys = new Set(
    rowsNeedingReview(rows, threshold).map((row) => `${row.date}|${row.panelType}|${row.marker}`),
  );

  // Resolve one panel per distinct (date, panel_type, lab_name) group so a
  // multi-marker panel only creates its header row once, then upsert every
  // result onto it. findOrCreateLabPanel is itself idempotent per group.
  const panelIdByKey = new Map<string, string>();
  let panelCount = 0;
  let resultCount = 0;

  for (const row of rows) {
    const key = `${row.date} ${row.panelType} ${row.labName ?? ''}`;
    let panelId = panelIdByKey.get(key);
    if (!panelId) {
      panelId = await findOrCreateLabPanel({
        date: row.date,
        panelType: row.panelType,
        labName: row.labName,
      });
      panelIdByKey.set(key, panelId);
      panelCount += 1;
    }
    const result: LabResultInput = {
      marker: row.marker,
      valueNumeric: row.valueNumeric,
      valueText: row.valueText,
      unit: row.unit,
      referenceLow: row.referenceLow,
      referenceHigh: row.referenceHigh,
      flag: row.flag,
      sourceFile: row.sourceFile,
      confidence: row.confidence,
      needsReview: lowKeys.has(`${row.date}|${row.panelType}|${row.marker}`),
      model,
    };
    await upsertLabResult(panelId, result);
    resultCount += 1;
  }

  console.log(`Imported ${resultCount} result(s) across ${panelCount} panel(s) from ${csvPath}`);
  console.log(buildReviewSummary(rowsNeedingReview(rows, threshold), threshold));
}

main()
  .catch((err) => {
    logger.error('import-lab-results failed', {}, err);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
