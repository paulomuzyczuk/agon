import { query } from './db';
import { applyMutations, type FieldMutation } from './sync/apply';
import { formatHlc } from '../lib/sync/hlc';
import type { AdjustmentFields } from '../lib/training/sessionOverlay';

// Writer/reader for session_adjustments — the "what actually happened" layer over
// the seeded program (migration 20260823000000). Nothing here ever touches
// planned_sessions, which is the whole point: `pnpm seed:planned` can re-run at
// any time without losing a single deviation.

export type AdjustmentSource = 'manual' | 'calendar';

export interface SessionAdjustment extends AdjustmentFields {
  plannedSessionId: string;
  source: AdjustmentSource;
}

/** Columns a caller may set. Omitted keys are left as they are on an existing row. */
export interface AdjustmentPatch {
  date?: string | null;
  description?: string | null;
  targetDistanceKm?: number | null;
  targetHrCap?: number | null;
  targetSessionType?: string | null;
  note?: string | null;
  detail?: string | null;
}

const COLUMNS: Record<keyof AdjustmentPatch, string> = {
  date: 'date',
  description: 'description',
  targetDistanceKm: 'target_distance_km',
  targetHrCap: 'target_hr_cap',
  targetSessionType: 'target_session_type',
  note: 'note',
  detail: 'detail',
};

/**
 * Create or update the adjustment for a session, patching ONLY the keys present
 * in `patch`. Absent keys keep their stored value (so recording a date move
 * doesn't wipe a distance override); an explicit null clears that one field.
 */
export async function upsertAdjustment(
  plannedSessionId: string,
  patch: AdjustmentPatch,
  source: AdjustmentSource = 'manual',
): Promise<void> {
  const keys = (Object.keys(patch) as (keyof AdjustmentPatch)[]).filter(
    (k) => patch[k] !== undefined,
  );
  if (keys.length === 0) return;

  const cols = keys.map((k) => COLUMNS[k]);
  const values = keys.map((k) => patch[k]);
  const placeholders = values.map((_, i) => `$${i + 3}`);
  // Only the patched columns appear in the DO UPDATE list, so an existing row's
  // other overrides survive untouched — unless that row was cleared (soft
  // deleted, MZY-206): then its old overrides are gone, exactly as when a clear
  // was a hard DELETE, and only this patch's columns come back.
  const updates = [
    ...cols.map((c, i) => `${c} = ${placeholders[i]}`),
    ...Object.values(COLUMNS)
      .filter((c) => !cols.includes(c))
      .map(
        (c) =>
          `${c} = CASE WHEN session_adjustments.deleted_at IS NULL THEN session_adjustments.${c} END`,
      ),
  ].join(', ');

  await query(
    `INSERT INTO public.session_adjustments
       (planned_session_id, source, ${cols.join(', ')})
     VALUES ($1, $2, ${placeholders.join(', ')})
     ON CONFLICT (planned_session_id) DO UPDATE SET
       ${updates}, source = EXCLUDED.source, deleted_at = NULL`,
    [plannedSessionId, source, ...values],
  );
}

/**
 * A Google Calendar hand edit, merged like any other human edit (MZY-208):
 * each patched field goes through mergeField() stamped with the time the
 * athlete edited the EVENT (`editedAt`, the event's `updated`), node 'gcal'.
 * So Calendar is one more human-origin peer: a later edit anywhere else (a
 * device, a manual script) wins over an older calendar edit and vice versa,
 * and no machine write can ever overwrite it. Returns the fields that won.
 */
export async function mergeCalendarAdjustment(
  plannedSessionId: string,
  patch: AdjustmentPatch,
  editedAt: string | undefined,
): Promise<string[]> {
  const { rows } = await query<{ id: string }>(
    'SELECT id FROM public.session_adjustments WHERE planned_session_id = $1',
    [plannedSessionId],
  );
  const id = rows[0]?.id ?? crypto.randomUUID();
  const edited = Date.parse(editedAt ?? '');
  const hlc = formatHlc({
    wall: Number.isNaN(edited) ? Date.now() : edited,
    counter: 0,
    node: 'gcal',
  });
  const values: Record<string, unknown> = {
    planned_session_id: plannedSessionId,
    source: 'calendar',
    deleted_at: null, // an edit on the calendar re-activates a cleared adjustment — if it is newer
  };
  for (const [key, column] of Object.entries(COLUMNS)) {
    const v = patch[key as keyof AdjustmentPatch];
    if (v !== undefined) values[column] = v;
  }
  const mutations: FieldMutation[] = Object.entries(values).map(
    ([field, value]) => ({
      table: 'session_adjustments',
      id,
      field,
      value,
      hlc,
      origin: 'human',
    }),
  );
  const results = await applyMutations(mutations, { serverWriter: true });
  const rejected = results.find((r) => r.status === 'rejected');
  if (rejected)
    throw new Error(`calendar adjustment rejected: ${rejected.error}`);
  return mutations
    .filter(
      (m, i) => results[i]!.status === 'applied' && m.field in COLUMNS_BY_NAME,
    )
    .map((m) => m.field);
}

const COLUMNS_BY_NAME = Object.fromEntries(
  Object.values(COLUMNS).map((c) => [c, true]),
);

/** Drop a session's adjustment entirely — "actually, do what the program says". */
export async function clearAdjustment(
  plannedSessionId: string,
): Promise<boolean> {
  // Soft (MZY-206): the tombstone replicates to devices like any other edit.
  const { rowCount } = await query(
    `UPDATE public.session_adjustments SET deleted_at = now()
      WHERE planned_session_id = $1 AND deleted_at IS NULL`,
    [plannedSessionId],
  );
  return (rowCount ?? 0) > 0;
}

/** Every adjustment, keyed by planned_session_id, for resolving a batch of sessions. */
export async function getAdjustmentsBySession(): Promise<
  Map<string, SessionAdjustment>
> {
  const { rows } = await query<{
    planned_session_id: string;
    date: string | null;
    description: string | null;
    target_distance_km: string | null;
    target_hr_cap: number | null;
    target_session_type: string | null;
    note: string | null;
    source: AdjustmentSource;
  }>(
    `SELECT planned_session_id, to_char(date, 'YYYY-MM-DD') AS date, description,
            target_distance_km, target_hr_cap, target_session_type, note, source
       FROM public.session_adjustments WHERE deleted_at IS NULL`,
  );
  return new Map(
    rows.map((r) => [
      r.planned_session_id,
      {
        plannedSessionId: r.planned_session_id,
        date: r.date,
        description: r.description,
        // NUMERIC arrives as a string from pg; normalize like plannedSessions does.
        targetDistanceKm:
          r.target_distance_km === null ? null : Number(r.target_distance_km),
        targetHrCap: r.target_hr_cap,
        targetSessionType: r.target_session_type,
        note: r.note,
        source: r.source,
      },
    ]),
  );
}
