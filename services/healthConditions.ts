import { query } from './db';
import type { ClientRowKeys } from './clientWrite';

// Allergies + chronic conditions — a small reference table, mainly
// consulting-layer context (so Claude knows constraints when giving advice),
// not a time series. UNIQUE(condition_type, name) so re-logging the same
// condition upserts its status/severity instead of duplicating.

export type ConditionType = 'allergy' | 'chronic_condition' | 'other';
export type ConditionStatus = 'active' | 'resolved' | 'managed';

export interface HealthConditionInput extends ClientRowKeys {
  conditionType: ConditionType;
  name: string;
  severity?: string | null;
  diagnosedDate?: string | null;
  status?: ConditionStatus;
  notes?: string | null;
}

export async function upsertHealthCondition(
  input: HealthConditionInput,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.health_conditions
       (condition_type, name, severity, diagnosed_date, status, notes, id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::uuid, gen_random_uuid()), COALESCE($8::timestamptz, now()))
     ON CONFLICT (condition_type, name) DO UPDATE
       SET severity = EXCLUDED.severity, diagnosed_date = EXCLUDED.diagnosed_date,
           status = EXCLUDED.status, notes = EXCLUDED.notes,
           deleted_at = NULL -- re-logging a deleted condition restores it
     RETURNING id`,
    [
      input.conditionType,
      input.name,
      input.severity ?? null,
      input.diagnosedDate ?? null,
      input.status ?? 'active',
      input.notes ?? null,
      input.id ?? null,
      input.capturedAt ?? null,
    ],
  );
  return rows[0]!.id;
}

export interface HealthConditionSummary {
  id: string;
  conditionType: ConditionType;
  name: string;
  severity: string | null;
  status: ConditionStatus;
  diagnosedDate: string | null;
}

/** All conditions (optionally filtered by type), active first. */
export async function listHealthConditions(
  conditionType?: ConditionType,
): Promise<HealthConditionSummary[]> {
  const { rows } = await query<{
    id: string;
    condition_type: ConditionType;
    name: string;
    severity: string | null;
    status: ConditionStatus;
    diagnosed_date: string | null;
  }>(
    conditionType
      ? `SELECT id, condition_type, name, severity, status, to_char(diagnosed_date,'YYYY-MM-DD') AS diagnosed_date
           FROM public.health_conditions WHERE condition_type = $1 AND deleted_at IS NULL
           ORDER BY (status = 'active') DESC, name`
      : `SELECT id, condition_type, name, severity, status, to_char(diagnosed_date,'YYYY-MM-DD') AS diagnosed_date
           FROM public.health_conditions WHERE deleted_at IS NULL
           ORDER BY (status = 'active') DESC, condition_type, name`,
    conditionType ? [conditionType] : [],
  );
  return rows.map((r) => ({
    id: r.id,
    conditionType: r.condition_type,
    name: r.name,
    severity: r.severity,
    status: r.status,
    diagnosedDate: r.diagnosed_date,
  }));
}
