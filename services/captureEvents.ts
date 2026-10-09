import { query, withTransaction } from './db';

// The capture ledger behind /undo. recordCaptureEvent() is called by every write
// path (text commands + voice fan-out) with the rows it created; undoLastCaptureEvent()
// reverses the most recent still-active entry in one transaction.

// Only these tables may be targeted by an undo. A hard whitelist so a malformed
// or malicious `targets` payload can never turn into DELETE FROM <arbitrary>.
// Deleting a parent cascades (lifting_sessions → exercises/sets; runs →
// run_fueling_items), so listing the parent is enough.
const UNDOABLE_TABLES = new Set([
  'body_metrics',
  'sweat_observations',
  'lifting_sessions',
  'runs',
  'run_fueling_items',
  'qualitative_logs',
  'gear_maintenance_log',
]);

export interface CaptureTarget {
  table: string;
  id: string;
}

export interface CaptureEventInput {
  kind: string;
  summary: string;
  targets: CaptureTarget[];
  source?: string;
}

/** Append a capture event; returns its id. */
export async function recordCaptureEvent(
  e: CaptureEventInput,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.capture_events (kind, summary, targets, source)
     VALUES ($1,$2,$3,$4)
     RETURNING id`,
    [e.kind, e.summary, JSON.stringify(e.targets), e.source ?? 'telegram'],
  );
  return rows[0]!.id;
}

export interface UndoResult {
  kind: string;
  summary: string;
}

/**
 * Reverse the most recent active capture: delete its target rows and mark it
 * undone. Returns the reversed event, or null if there's nothing to undo. Runs in
 * one transaction with FOR UPDATE so concurrent /undo calls can't double-reverse.
 */
export async function undoLastCaptureEvent(): Promise<UndoResult | null> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      id: string;
      kind: string;
      summary: string;
      targets: CaptureTarget[];
    }>(
      `SELECT id, kind, summary, targets
         FROM public.capture_events
        WHERE undone_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
    );
    const event = rows[0];
    if (!event) return null;

    for (const target of event.targets) {
      if (!UNDOABLE_TABLES.has(target.table)) {
        throw new Error(
          `undo: refusing to delete from non-whitelisted table '${target.table}'`,
        );
      }
      // Table name is whitelisted above, so this interpolation is safe; the id is
      // still a bound parameter. A row already gone (cascade) just deletes 0 rows.
      await client.query(`DELETE FROM public.${target.table} WHERE id = $1`, [
        target.id,
      ]);
    }

    await client.query(
      `UPDATE public.capture_events SET undone_at = now() WHERE id = $1`,
      [event.id],
    );
    return { kind: event.kind, summary: event.summary };
  });
}
