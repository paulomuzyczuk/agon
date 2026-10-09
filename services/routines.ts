import type { PoolClient } from 'pg';
import { query, withTransaction } from './db';
import type { ClientRowKeys } from './clientWrite';

// Skincare + dental care habit tracking. Mirrors meal_templates/meal_logs: a
// reusable routine definition (its ordered steps) plus a daily adherence log,
// one row per routine per day (UNIQUE(date, routine_id) — logging again for
// the same day upserts rather than duplicating).

export type RoutineType = 'skincare' | 'dental';
export type TimeOfDay = 'am' | 'pm' | 'any';

export interface RoutineStepInput {
  product: string;
  notes?: string | null;
}

export interface RoutineInput extends ClientRowKeys {
  name: string;
  routineType: RoutineType;
  timeOfDay?: TimeOfDay | null;
  notes?: string | null;
  steps: RoutineStepInput[];
}

/** Create a routine + its steps in one transaction. */
export async function createRoutine(input: RoutineInput): Promise<string> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO public.routines (name, routine_type, time_of_day, notes, id, created_at)
       VALUES ($1,$2,$3,$4, COALESCE($5::uuid, gen_random_uuid()), COALESCE($6::timestamptz, now()))
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        input.name,
        input.routineType,
        input.timeOfDay ?? null,
        input.notes ?? null,
        input.id ?? null,
        input.capturedAt ?? null,
      ],
    );
    if (!rows[0]) return input.id!; // replay — steps already written
    const routineId = rows[0].id;
    await insertSteps(client, routineId, input.steps);
    return routineId;
  });
}

async function insertSteps(
  client: PoolClient,
  routineId: string,
  steps: RoutineStepInput[],
): Promise<void> {
  for (const [i, step] of steps.entries()) {
    await client.query(
      `INSERT INTO public.routine_steps (routine_id, step_order, product, notes)
       VALUES ($1,$2,$3,$4)`,
      [routineId, i, step.product, step.notes ?? null],
    );
  }
}

export interface RoutineSummary {
  id: string;
  name: string;
  routineType: RoutineType;
  timeOfDay: TimeOfDay | null;
  steps: { product: string; notes: string | null }[];
}

/** All routines (optionally filtered by type), with their steps. */
export async function listRoutines(
  routineType?: RoutineType,
): Promise<RoutineSummary[]> {
  const { rows: routineRows } = await query<{
    id: string;
    name: string;
    routine_type: RoutineType;
    time_of_day: TimeOfDay | null;
  }>(
    routineType
      ? `SELECT id, name, routine_type, time_of_day FROM public.routines WHERE routine_type = $1 AND deleted_at IS NULL ORDER BY name`
      : `SELECT id, name, routine_type, time_of_day FROM public.routines WHERE deleted_at IS NULL ORDER BY routine_type, name`,
    routineType ? [routineType] : [],
  );
  if (routineRows.length === 0) return [];

  const { rows: stepRows } = await query<{
    routine_id: string;
    product: string;
    notes: string | null;
  }>(
    `SELECT routine_id, product, notes FROM public.routine_steps
      WHERE routine_id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY step_order`,
    [routineRows.map((r) => r.id)],
  );

  return routineRows.map((r) => ({
    id: r.id,
    name: r.name,
    routineType: r.routine_type,
    timeOfDay: r.time_of_day,
    steps: stepRows
      .filter((s) => s.routine_id === r.id)
      .map((s) => ({ product: s.product, notes: s.notes })),
  }));
}

/** Log (or update) today's adherence for one routine. */
export async function logRoutine(
  input: ClientRowKeys & {
    date: string;
    routineId: string;
    completed?: boolean;
    notes?: string | null;
  },
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.routine_logs (date, routine_id, completed, notes, id, created_at)
     VALUES ($1,$2,$3,$4, COALESCE($5::uuid, gen_random_uuid()), COALESCE($6::timestamptz, now()))
     ON CONFLICT (date, routine_id) DO UPDATE
       SET completed = EXCLUDED.completed, notes = EXCLUDED.notes,
           deleted_at = NULL -- re-logging a deleted check-off restores it
     RETURNING id`,
    [
      input.date,
      input.routineId,
      input.completed ?? true,
      input.notes ?? null,
      input.id ?? null,
      input.capturedAt ?? null,
    ],
  );
  return rows[0]!.id;
}

export interface RoutineAdherenceDay {
  date: string;
  routineId: string;
  routineName: string;
  completed: boolean;
}

/** Adherence log entries in a date range (default last 30 days), for a streak/compliance view. */
export async function getRoutineAdherence(
  fromISO?: string,
): Promise<RoutineAdherenceDay[]> {
  const from = fromISO ?? '1900-01-01';
  const { rows } = await query<{
    date: string;
    routine_id: string;
    routine_name: string;
    completed: boolean;
  }>(
    `SELECT to_char(rl.date,'YYYY-MM-DD') AS date, rl.routine_id, r.name AS routine_name, rl.completed
       FROM public.routine_logs rl
       JOIN public.routines r ON r.id = rl.routine_id
      WHERE rl.date >= $1 AND rl.deleted_at IS NULL AND r.deleted_at IS NULL
      ORDER BY rl.date DESC`,
    [from],
  );
  return rows.map((r) => ({
    date: r.date,
    routineId: r.routine_id,
    routineName: r.routine_name,
    completed: r.completed,
  }));
}
