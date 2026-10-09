import type { PoolClient } from 'pg';
import { query, withTransaction } from './db';
import { applyMutations, rowMutations } from './sync/apply';
import type { ClientRowKeys } from './clientWrite';

// Any test event (blood panel, spermogram, hormone panel, urinalysis, ...) as
// a header row (lab_panels) + one row per marker (lab_panel_results). marker
// is open text — same "new value is a data change, not a migration" rationale
// as nutrition_goals.goal_key. Reference ranges are entered per-result (a lab
// report prints its own), never hardcoded.
//
// Ingestion mirrors sihha's psychometric_results pattern (public repo:
// supabase/migrations/20260714040000_psychometric_results.sql +
// scripts/import-psychometrics.ts): results upsert on a natural key
// ((lab_panel_id, marker) here vs sihha's (recipient_id, test_date,
// instrument, measure)) so a corrected CSV re-import overwrites in place
// instead of duplicating. findOrCreateLabPanel + upsertLabResult are the
// building blocks scripts/import-lab-results.ts uses for that path.

export interface LabResultInput {
  marker: string;
  valueNumeric?: number | null;
  valueText?: string | null;
  unit?: string | null;
  referenceLow?: number | null;
  referenceHigh?: number | null;
  flag?: 'low' | 'normal' | 'high' | 'abnormal' | null;
  notes?: string | null;
  sourceFile?: string | null;
  /** Extractor self-assessed confidence (0-1); null for manual/API entry. */
  confidence?: number | null;
  /** True when confidence fell below the import threshold — a doubtful figure to double-check. */
  needsReview?: boolean;
  /** The extractor model id, if imported via the lab-ingestion skill. */
  model?: string | null;
}

export interface LabPanelInput extends ClientRowKeys {
  date: string;
  panelType: string;
  labName?: string | null;
  notes?: string | null;
  results: LabResultInput[];
}

/** Insert a panel header + all its marker results in one transaction. */
export async function logLabPanel(input: LabPanelInput): Promise<string> {
  if (input.results.length === 0) {
    throw new Error('logLabPanel: at least one result is required');
  }
  for (const r of input.results) {
    if (r.valueNumeric == null && r.valueText == null) {
      throw new Error(
        `logLabPanel: marker "${r.marker}" needs valueNumeric or valueText`,
      );
    }
  }
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO public.lab_panels (date, panel_type, lab_name, notes, id, created_at)
       VALUES ($1,$2,$3,$4, COALESCE($5::uuid, gen_random_uuid()), COALESCE($6::timestamptz, now()))
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        input.date,
        input.panelType,
        input.labName ?? null,
        input.notes ?? null,
        input.id ?? null,
        input.capturedAt ?? null,
      ],
    );
    if (!rows[0]) return input.id!; // replay — results already written
    const panelId = rows[0].id;
    for (const r of input.results) {
      await upsertResult(client, panelId, r);
    }
    return panelId;
  });
}

async function upsertResult(
  client: PoolClient,
  panelId: string,
  r: LabResultInput,
): Promise<void> {
  await client.query(
    `INSERT INTO public.lab_panel_results
       (lab_panel_id, marker, value_numeric, value_text, unit, reference_low, reference_high, flag, notes, source_file, confidence, needs_review, model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (lab_panel_id, marker) DO UPDATE
       SET value_numeric = EXCLUDED.value_numeric, value_text = EXCLUDED.value_text,
           unit = EXCLUDED.unit, reference_low = EXCLUDED.reference_low,
           reference_high = EXCLUDED.reference_high, flag = EXCLUDED.flag,
           notes = EXCLUDED.notes, source_file = EXCLUDED.source_file,
           confidence = EXCLUDED.confidence, needs_review = EXCLUDED.needs_review,
           model = EXCLUDED.model`,
    [
      panelId,
      r.marker,
      r.valueNumeric ?? null,
      r.valueText ?? null,
      r.unit ?? null,
      r.referenceLow ?? null,
      r.referenceHigh ?? null,
      r.flag ?? null,
      r.notes ?? null,
      r.sourceFile ?? null,
      r.confidence ?? null,
      r.needsReview ?? false,
      r.model ?? null,
    ],
  );
}

/**
 * Find an existing panel by (date, panel_type), or create one. The natural
 * key a CSV re-import resolves against — mirrors sihha's find-the-recipient
 * step in scripts/import-psychometrics.ts, adapted since Agon's panels (unlike
 * sihha's flat psychometric_results) have a real header row to reuse.
 */
export async function findOrCreateLabPanel(input: {
  date: string;
  panelType: string;
  labName?: string | null;
  notes?: string | null;
}): Promise<string> {
  const { rows: existing } = await query<{ id: string }>(
    `SELECT id FROM public.lab_panels WHERE date = $1 AND panel_type = $2 AND deleted_at IS NULL LIMIT 1`,
    [input.date, input.panelType],
  );
  const id = existing[0]?.id ?? crypto.randomUUID();
  const values: Record<string, unknown> = existing[0]
    ? // Only fill in what the import knows; never blank a field it doesn't.
      { lab_name: input.labName ?? undefined, notes: input.notes ?? undefined }
    : {
        date: input.date,
        panel_type: input.panelType,
        lab_name: input.labName ?? null,
        notes: input.notes ?? null,
      };
  await applyMachineWrite('lab_panels', id, values);
  return id;
}

/**
 * Upsert one marker result onto an existing panel (the importer's per-row
 * write). A MACHINE write through the sync merge path (MZY-206): a value the
 * athlete corrected by hand is kept, while fields nobody touched still get
 * the re-extracted value.
 */
export async function upsertLabResult(
  panelId: string,
  r: LabResultInput,
): Promise<void> {
  if (r.valueNumeric == null && r.valueText == null) {
    throw new Error(
      `upsertLabResult: marker "${r.marker}" needs valueNumeric or valueText`,
    );
  }
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM public.lab_panel_results WHERE lab_panel_id = $1 AND marker = $2`,
    [panelId, r.marker],
  );
  await applyMachineWrite(
    'lab_panel_results',
    rows[0]?.id ?? crypto.randomUUID(),
    {
      lab_panel_id: panelId,
      marker: r.marker,
      value_numeric: r.valueNumeric ?? null,
      value_text: r.valueText ?? null,
      unit: r.unit ?? null,
      reference_low: r.referenceLow ?? null,
      reference_high: r.referenceHigh ?? null,
      flag: r.flag ?? null,
      notes: r.notes ?? null,
      source_file: r.sourceFile ?? null,
      confidence: r.confidence ?? null,
      needs_review: r.needsReview ?? false,
      model: r.model ?? null,
    },
  );
}

async function applyMachineWrite(
  table: 'lab_panels' | 'lab_panel_results',
  id: string,
  values: Record<string, unknown>,
): Promise<void> {
  const results = await applyMutations(
    rowMutations(table, id, values, 'machine', 'lab-import'),
    {
      serverWriter: true,
    },
  );
  const rejected = results.find((x) => x.status === 'rejected');
  if (rejected)
    throw new Error(`lab import write to ${table} rejected: ${rejected.error}`);
}

export interface LabPanelSummary {
  id: string;
  date: string;
  panelType: string;
  labName: string | null;
  results: {
    marker: string;
    valueNumeric: number | null;
    valueText: string | null;
    unit: string | null;
    flag: 'low' | 'normal' | 'high' | 'abnormal' | null;
    needsReview: boolean;
  }[];
}

/** Most recent panels (default 20), each with its results — for a "recent tests" list. */
export async function listLabPanels(limit = 20): Promise<LabPanelSummary[]> {
  const { rows: panelRows } = await query<{
    id: string;
    date: string;
    panel_type: string;
    lab_name: string | null;
  }>(
    `SELECT id, to_char(date,'YYYY-MM-DD') AS date, panel_type, lab_name
       FROM public.lab_panels WHERE deleted_at IS NULL ORDER BY date DESC, created_at DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  if (panelRows.length === 0) return [];

  const { rows: resultRows } = await query<{
    lab_panel_id: string;
    marker: string;
    value_numeric: string | null;
    value_text: string | null;
    unit: string | null;
    flag: 'low' | 'normal' | 'high' | 'abnormal' | null;
    needs_review: boolean;
  }>(
    `SELECT lab_panel_id, marker, value_numeric, value_text, unit, flag, needs_review
       FROM public.lab_panel_results WHERE lab_panel_id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [panelRows.map((p) => p.id)],
  );

  return panelRows.map((p) => ({
    id: p.id,
    date: p.date,
    panelType: p.panel_type,
    labName: p.lab_name,
    results: resultRows
      .filter((r) => r.lab_panel_id === p.id)
      .map((r) => ({
        marker: r.marker,
        valueNumeric: r.value_numeric != null ? Number(r.value_numeric) : null,
        valueText: r.value_text,
        unit: r.unit,
        flag: r.flag,
        needsReview: r.needs_review,
      })),
  }));
}

export interface MarkerTrendPoint {
  date: string;
  valueNumeric: number | null;
  valueText: string | null;
  unit: string | null;
  flag: string | null;
}

/** History of one marker across panels (e.g. "testosterone" over time), oldest first. */
export async function getMarkerTrend(
  marker: string,
): Promise<MarkerTrendPoint[]> {
  const { rows } = await query<{
    date: string;
    value_numeric: string | null;
    value_text: string | null;
    unit: string | null;
    flag: string | null;
  }>(
    `SELECT to_char(p.date,'YYYY-MM-DD') AS date, r.value_numeric, r.value_text, r.unit, r.flag
       FROM public.lab_panel_results r
       JOIN public.lab_panels p ON p.id = r.lab_panel_id
      WHERE lower(r.marker) = lower($1)
        AND r.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY p.date ASC`,
    [marker],
  );
  return rows.map((r) => ({
    date: r.date,
    valueNumeric: r.value_numeric != null ? Number(r.value_numeric) : null,
    valueText: r.value_text,
    unit: r.unit,
    flag: r.flag,
  }));
}

export interface LabResultTrendRow {
  date: string;
  panelType: string;
  marker: string;
  valueNumeric: number | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  flag: 'low' | 'normal' | 'high' | 'abnormal' | null;
  needsReview: boolean;
}

/**
 * Every marker result across every panel, flat (no per-panel nesting) and
 * unlimited — the shape the trend chart needs. Mirrors the query behind
 * sihha's `GET /api/psychometrics` (selects every row for the recipient,
 * ordered by date then the grouping column) rather than listLabPanels'
 * capped "recent panels" list.
 */
export async function listLabResultsFlat(): Promise<LabResultTrendRow[]> {
  const { rows } = await query<{
    date: string;
    panel_type: string;
    marker: string;
    value_numeric: string | null;
    unit: string | null;
    reference_low: string | null;
    reference_high: string | null;
    flag: 'low' | 'normal' | 'high' | 'abnormal' | null;
    needs_review: boolean;
  }>(
    `SELECT to_char(p.date,'YYYY-MM-DD') AS date, p.panel_type, r.marker,
            r.value_numeric, r.unit, r.reference_low, r.reference_high, r.flag, r.needs_review
       FROM public.lab_panel_results r
       JOIN public.lab_panels p ON p.id = r.lab_panel_id
      WHERE r.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY p.date ASC, p.panel_type ASC`,
  );
  return rows.map((r) => ({
    date: r.date,
    panelType: r.panel_type,
    marker: r.marker,
    valueNumeric: r.value_numeric != null ? Number(r.value_numeric) : null,
    unit: r.unit,
    referenceLow: r.reference_low != null ? Number(r.reference_low) : null,
    referenceHigh: r.reference_high != null ? Number(r.reference_high) : null,
    flag: r.flag,
    needsReview: r.needs_review,
  }));
}
