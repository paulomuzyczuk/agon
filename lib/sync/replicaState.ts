import type { SyncRow } from '../outboxQueue';

// The device replica's pure state transitions (MZY-207). lib/sync/replica.ts
// keeps the rows in IndexedDB; everything that decides WHAT to store lives
// here so it is unit-tested:
//
//   applyPulled   — rows from GET /api/sync/pull replace the local copy
//                   wholesale: the server row is the merged truth. Aliases
//                   drop the duplicate local row (the canonical one arrives
//                   in the same or a later pull).
//   applyLocal    — the athlete's own not-yet-synced writes, laid over the
//                   local copy so the page shows them immediately (and
//                   re-laid after every pull until the outbox delivers them).
//
// A replicated row is its server column map (to_jsonb of the Postgres row):
// snake_case fields, `deleted_at` tombstones included.

export type ReplicaRow = Record<string, unknown> & { id: string };
export type ReplicaTables = Record<string, Map<string, ReplicaRow>>;

export interface PulledChange {
  table: string;
  seq: number;
  row: Record<string, unknown>;
}

export interface PulledAlias {
  aliasId: string;
  table: string;
  canonicalId: string;
}

function tableOf(tables: ReplicaTables, name: string): Map<string, ReplicaRow> {
  let t = tables[name];
  if (!t) {
    t = new Map();
    tables[name] = t;
  }
  return t;
}

/** Returns the ids touched per table, for the IndexedDB writer. */
export function applyPulled(
  tables: ReplicaTables,
  changes: PulledChange[],
  aliases: PulledAlias[],
): { put: Record<string, string[]>; removed: Record<string, string[]> } {
  const put: Record<string, string[]> = {};
  const removed: Record<string, string[]> = {};
  for (const c of changes) {
    const row = c.row as ReplicaRow;
    tableOf(tables, c.table).set(row.id, row);
    (put[c.table] ??= []).push(row.id);
  }
  for (const a of aliases) {
    if (tableOf(tables, a.table).delete(a.aliasId))
      (removed[a.table] ??= []).push(a.aliasId);
  }
  return { put, removed };
}

/** Optimistically lay the athlete's own writes over the local rows. */
export function applyLocal(
  tables: ReplicaTables,
  rows: SyncRow[],
): Record<string, string[]> {
  const put: Record<string, string[]> = {};
  for (const r of rows) {
    const t = tableOf(tables, r.table);
    const current = t.get(r.id) ?? { id: r.id };
    const next: ReplicaRow = { ...current, id: r.id };
    for (const [field, value] of Object.entries(r.values)) {
      if (value !== undefined) next[field] = value;
    }
    t.set(r.id, next);
    (put[r.table] ??= []).push(r.id);
  }
  return put;
}

/** Live (non-tombstoned) rows of a table. */
export function live(tables: ReplicaTables, name: string): ReplicaRow[] {
  return [...(tables[name]?.values() ?? [])].filter(
    (r) => r.deleted_at == null,
  );
}
