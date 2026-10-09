import type { SyncRow } from '../outboxQueue';
import { observeHlc } from './deviceClock';
import {
  applyLocal,
  applyPulled,
  type PulledAlias,
  type PulledChange,
  type ReplicaRow,
  type ReplicaTables,
} from './replicaState';
import { SYNC_TABLE_NAMES } from './schema';

// The device's full-history replica of the athlete-authored tables (MZY-207).
// One IndexedDB store per replicated table, kept current by cursor pulls from
// GET /api/sync/pull — the FIRST pull hydrates everything, not a recent
// window, so every signed-in device doubles as a recovery copy (the lesson of
// the 2026-09-08 volume deletion, MZY-113; restore path:
// scripts/restore-from-device-export.ts). Pages render from it through
// lib/sync/views.ts, so history stays visible offline.
//
// Integration surface like lib/outbox.ts: exercised live in the browser; the
// state transitions are pure and unit-tested in replicaState.ts.

const DB_NAME = 'agon-replica';
const DB_VERSION = 1;
const META = 'meta';
const PULL_LIMIT = 1000;

export interface ReplicaStatus {
  hydrated: boolean;
  cursor: number;
  lastSyncedAt: string | null;
  syncing: boolean;
  /** Last pull failed with 401 — replica is stale until sign-in. */
  authRequired: boolean;
}

let tables: ReplicaTables | null = null;
let status: ReplicaStatus = {
  hydrated: false,
  cursor: 0,
  lastSyncedAt: null,
  syncing: false,
  authRequired: false,
};
let version = 0;
const listeners = new Set<() => void>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const t of SYNC_TABLE_NAMES) {
        if (!db.objectStoreNames.contains(t))
          db.createObjectStore(t, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () =>
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

function setStatus(patch: Partial<ReplicaStatus>): void {
  status = { ...status, ...patch };
  emit();
}

/** Load the replica into memory once per page (it is the athlete's data only — small). */
export async function loadReplica(): Promise<ReplicaTables> {
  if (tables) return tables;
  const db = await openDb();
  const tx = db.transaction([...SYNC_TABLE_NAMES, META], 'readonly');
  const loaded: ReplicaTables = {};
  for (const t of SYNC_TABLE_NAMES) {
    const rows = await req(
      tx.objectStore(t).getAll() as IDBRequest<ReplicaRow[]>,
    );
    loaded[t] = new Map(rows.map((r) => [r.id, r]));
  }
  const cursor =
    ((await req(tx.objectStore(META).get('cursor'))) as number | undefined) ??
    0;
  const lastSyncedAt =
    ((await req(tx.objectStore(META).get('lastSyncedAt'))) as
      string | undefined) ?? null;
  tables = loaded;
  setStatus({ cursor, lastSyncedAt, hydrated: cursor > 0 });
  return tables;
}

async function persist(
  touched: {
    put: Record<string, string[]>;
    removed?: Record<string, string[]>;
  },
  meta: Record<string, unknown> = {},
): Promise<void> {
  const t = tables!;
  const db = await openDb();
  const tx = db.transaction([...SYNC_TABLE_NAMES, META], 'readwrite');
  for (const [name, ids] of Object.entries(touched.put)) {
    if (!SYNC_TABLE_NAMES.includes(name as never)) continue;
    for (const id of ids) {
      const row = t[name]?.get(id);
      if (row) tx.objectStore(name).put(row);
    }
  }
  for (const [name, ids] of Object.entries(touched.removed ?? {})) {
    for (const id of ids) tx.objectStore(name).delete(id);
  }
  for (const [k, v] of Object.entries(meta)) tx.objectStore(META).put(v, k);
  await done(tx);
}

/** The athlete's own write, shown immediately (before it has synced). */
export async function applyLocalRows(rows: SyncRow[]): Promise<void> {
  await loadReplica();
  await persist({ put: applyLocal(tables!, rows) });
  emit();
}

function observeStamps(changes: PulledChange[]): void {
  let max = '';
  for (const c of changes) {
    const stamps = c.row.field_hlc as
      Record<string, { hlc?: string }> | undefined;
    for (const s of Object.values(stamps ?? {}))
      if (s?.hlc && s.hlc > max) max = s.hlc;
  }
  if (max) observeHlc(max);
}

/**
 * Pull everything since the cursor (all history on a fresh device), then lay
 * the still-unsynced local writes back on top. Returns false when offline or
 * signed out — the replica simply stays as it was.
 */
export async function pullReplica(
  pendingRows: () => Promise<SyncRow[]>,
): Promise<boolean> {
  await loadReplica();
  setStatus({ syncing: true });
  try {
    for (;;) {
      let res: Response;
      try {
        res = await fetch(
          `/api/sync/pull?since=${status.cursor}&limit=${PULL_LIMIT}`,
          {
            credentials: 'same-origin',
            cache: 'no-store',
          },
        );
      } catch {
        return false;
      }
      if (res.status === 401) {
        setStatus({ authRequired: true });
        return false;
      }
      if (!res.ok) return false;
      const page = (await res.json()) as {
        changes: PulledChange[];
        aliases: PulledAlias[];
        cursor: number;
        hasMore: boolean;
      };
      const touched = applyPulled(tables!, page.changes, page.aliases);
      observeStamps(page.changes);
      const lastSyncedAt = new Date().toISOString();
      await persist(touched, { cursor: page.cursor, lastSyncedAt });
      setStatus({
        cursor: page.cursor,
        lastSyncedAt,
        hydrated: true,
        authRequired: false,
      });
      if (!page.hasMore) break;
    }
    const pending = await pendingRows();
    if (pending.length) await persist({ put: applyLocal(tables!, pending) });
    return true;
  } finally {
    setStatus({ syncing: false });
  }
}

export function replicaStatus(): ReplicaStatus {
  return status;
}

export function replicaTables(): ReplicaTables | null {
  return tables;
}

/** Re-render hook: bumps on every replica or status change. */
export function subscribeReplica(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function replicaVersion(): number {
  return version;
}

export interface ReplicaExport {
  format: 'agon-replica-export';
  version: 1;
  exportedAt: string;
  cursor: number;
  tables: Record<string, ReplicaRow[]>;
}

/** Everything on this device, for scripts/restore-from-device-export.ts. */
export async function exportReplica(): Promise<ReplicaExport> {
  const t = await loadReplica();
  return {
    format: 'agon-replica-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    cursor: status.cursor,
    tables: Object.fromEntries(
      SYNC_TABLE_NAMES.map((n) => [n, [...(t[n]?.values() ?? [])]]),
    ),
  };
}
