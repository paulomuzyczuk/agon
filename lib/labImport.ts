// Pure CSV parsing + review-threshold logic behind scripts/import-lab-results.ts
// and the lab-ingestion skill. Kept in lib/ (not the script) so it's unit
// testable without touching fs/DB — mirrors the lib/-holds-pure-logic
// convention used elsewhere (lib/nutritionGoals.ts, lib/labTrends.ts), rather
// than sihha's pattern of exporting pure helpers straight from the script file
// behind a `require.main === module` guard (Agon's scripts stay thin CLI
// wrappers around lib/services logic; see scripts/import-run-file.ts).
//
// CSV columns (header required, no quoted fields — text values must not
// contain commas):
//   date,panel_type,lab_name,marker,value_numeric,value_text,unit,reference_low,reference_high,flag,confidence,source_file

export interface LabCsvRow {
  date: string;
  panelType: string;
  labName: string | null;
  marker: string;
  valueNumeric: number | null;
  valueText: string | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  flag: 'low' | 'normal' | 'high' | 'abnormal' | null;
  /** Extractor self-assessed confidence, 0-1; null when hand-entered/manually verified (treated as fully trusted). */
  confidence: number | null;
  sourceFile: string | null;
}

export const LAB_CSV_HEADER = [
  'date',
  'panel_type',
  'lab_name',
  'marker',
  'value_numeric',
  'value_text',
  'unit',
  'reference_low',
  'reference_high',
  'flag',
  'confidence',
  'source_file',
] as const;

export const DEFAULT_LAB_CONFIDENCE_THRESHOLD = 0.85;

const VALID_FLAGS = new Set(['low', 'normal', 'high', 'abnormal', '']);

export function parseLabCsv(content: string): LabCsvRow[] {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const header = lines[0]?.split(',').map((cell) => cell.trim());
  if (JSON.stringify(header) !== JSON.stringify(LAB_CSV_HEADER)) {
    throw new Error(
      `parseLabCsv: unexpected header ${JSON.stringify(header)}; ` +
        `expected ${JSON.stringify(LAB_CSV_HEADER)}`,
    );
  }
  return lines.slice(1).map((line, index) => {
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length !== LAB_CSV_HEADER.length) {
      throw new Error(
        `parseLabCsv: row ${index + 2} has ${cells.length} cells, ` +
          `expected ${LAB_CSV_HEADER.length}: ${line}`,
      );
    }
    const [
      date,
      panelType,
      labName,
      marker,
      valueNumeric,
      valueText,
      unit,
      referenceLow,
      referenceHigh,
      flag,
      confidence,
      sourceFile,
    ] = cells;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date!)) {
      throw new Error(`parseLabCsv: row ${index + 2} date "${date}" is not YYYY-MM-DD`);
    }
    if (!panelType) {
      throw new Error(`parseLabCsv: row ${index + 2} missing panel_type`);
    }
    if (!marker) {
      throw new Error(`parseLabCsv: row ${index + 2} missing marker`);
    }
    const num = (cell: string | undefined, field: string): number | null => {
      if (!cell) return null;
      const parsed = Number(cell);
      if (!Number.isFinite(parsed)) {
        throw new Error(`parseLabCsv: row ${index + 2} has non-numeric ${field} "${cell}"`);
      }
      return parsed;
    };
    if (!VALID_FLAGS.has(flag ?? '')) {
      throw new Error(
        `parseLabCsv: row ${index + 2} has invalid flag "${flag}" ` +
          `(expected low/normal/high/abnormal/blank)`,
      );
    }
    const parsedConfidence = num(confidence, 'confidence');
    if (parsedConfidence != null && (parsedConfidence < 0 || parsedConfidence > 1)) {
      throw new Error(
        `parseLabCsv: row ${index + 2} confidence ${parsedConfidence} outside [0, 1]`,
      );
    }
    return {
      date: date!,
      panelType: panelType!,
      labName: labName || null,
      marker: marker!,
      valueNumeric: num(valueNumeric, 'value_numeric'),
      valueText: valueText || null,
      unit: unit || null,
      referenceLow: num(referenceLow, 'reference_low'),
      referenceHigh: num(referenceHigh, 'reference_high'),
      flag: (flag || null) as LabCsvRow['flag'],
      confidence: parsedConfidence,
      sourceFile: sourceFile || null,
    };
  });
}

/** Rows whose extraction confidence the athlete should double-check before trusting the figure. */
export function rowsNeedingReview(rows: LabCsvRow[], threshold: number): LabCsvRow[] {
  return rows.filter((row) => row.confidence != null && row.confidence < threshold);
}

/**
 * Plain-text review summary for the importing session to relay directly to
 * the athlete — Agon has no e-mail/alerting infra (single-user; mirrors
 * sihha's buildLabReviewEmailBody, minus the e-mail transport).
 */
export function buildReviewSummary(lowRows: LabCsvRow[], threshold: number): string {
  if (lowRows.length === 0) {
    return 'All rows at or above the confidence threshold — no review needed.';
  }
  const lines = lowRows.map(
    (row) =>
      `- ${row.date} · ${row.marker}: ${row.valueNumeric ?? row.valueText} ${row.unit ?? ''}`.trimEnd() +
      `${row.referenceLow != null && row.referenceHigh != null ? ` (ref. ${row.referenceLow}-${row.referenceHigh})` : ''}` +
      ` — confidence ${Math.round((row.confidence ?? 0) * 100)}%`,
  );
  return (
    `${lowRows.length} row(s) below the ${Math.round(threshold * 100)}% confidence threshold — please double-check:\n` +
    lines.join('\n')
  );
}
