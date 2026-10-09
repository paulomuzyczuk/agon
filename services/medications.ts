import { query } from './db';
import type { ClientRowKeys } from './clientWrite';

// General medication + supplement ledger — separate from the training-program
// creatine goal already tracked in nutrition_goals/nutrition_days. `active`
// flags what's currently being taken without deleting history.

export type MedicationKind = 'medication' | 'supplement';

export interface MedicationInput extends ClientRowKeys {
  name: string;
  kind: MedicationKind;
  dosage?: string | null;
  schedule?: string | null;
  active?: boolean;
  notes?: string | null;
}

/** Create or update a medication/supplement by name (idempotent on name). */
export async function upsertMedication(
  input: MedicationInput,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.medications (name, kind, dosage, schedule, active, notes, id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::uuid, gen_random_uuid()), COALESCE($8::timestamptz, now()))
     ON CONFLICT (name) DO UPDATE
       SET kind = EXCLUDED.kind, dosage = EXCLUDED.dosage,
           schedule = EXCLUDED.schedule, active = EXCLUDED.active, notes = EXCLUDED.notes,
           deleted_at = NULL -- re-adding a deleted medication restores it
     RETURNING id`,
    [
      input.name,
      input.kind,
      input.dosage ?? null,
      input.schedule ?? null,
      input.active ?? true,
      input.notes ?? null,
      input.id ?? null,
      input.capturedAt ?? null,
    ],
  );
  return rows[0]!.id;
}

export interface MedicationRecord {
  id: string;
  name: string;
  kind: MedicationKind;
  dosage: string | null;
  schedule: string | null;
  active: boolean;
  notes: string | null;
}

/** All medications/supplements, active first. */
export async function listMedications(): Promise<MedicationRecord[]> {
  const { rows } = await query<{
    id: string;
    name: string;
    kind: MedicationKind;
    dosage: string | null;
    schedule: string | null;
    active: boolean;
    notes: string | null;
  }>(
    `SELECT id, name, kind, dosage, schedule, active, notes
       FROM public.medications WHERE deleted_at IS NULL ORDER BY active DESC, name`,
  );
  return rows;
}

async function resolveMedicationId(name: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM public.medications WHERE lower(name) = lower($1) AND deleted_at IS NULL`,
    [name],
  );
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(
      `Unmatched medication "${name}" — add it via upsertMedication first.`,
    );
  }
  return id;
}

/** Log a dose taken (resolves the medication by name). */
export async function logMedicationDose(
  input: ClientRowKeys & {
    medicationName: string;
    date: string;
    takenAt?: string | null;
    quantity?: number;
    notes?: string | null;
  },
): Promise<string> {
  const medicationId = await resolveMedicationId(input.medicationName);
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.medication_logs (medication_id, date, taken_at, quantity, notes, id, created_at)
     VALUES ($1,$2,$3,$4,$5, COALESCE($6::uuid, gen_random_uuid()), COALESCE($7::timestamptz, now()))
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      medicationId,
      input.date,
      input.takenAt ?? null,
      input.quantity ?? 1,
      input.notes ?? null,
      input.id ?? null,
      input.capturedAt ?? null,
    ],
  );
  return rows[0]?.id ?? input.id!; // no row back = replay of a client write
}

export interface MedicationLogEntry {
  date: string;
  medicationName: string;
  quantity: number;
}

/** Dose log entries in a date range (default last 30 days). */
export async function listMedicationLogs(
  fromISO?: string,
): Promise<MedicationLogEntry[]> {
  const from = fromISO ?? '1900-01-01';
  const { rows } = await query<{
    date: string;
    medication_name: string;
    quantity: string;
  }>(
    `SELECT to_char(ml.date,'YYYY-MM-DD') AS date, m.name AS medication_name, ml.quantity
       FROM public.medication_logs ml
       JOIN public.medications m ON m.id = ml.medication_id
      WHERE ml.date >= $1 AND ml.deleted_at IS NULL AND m.deleted_at IS NULL
      ORDER BY ml.date DESC`,
    [from],
  );
  return rows.map((r) => ({
    date: r.date,
    medicationName: r.medication_name,
    quantity: Number(r.quantity),
  }));
}
