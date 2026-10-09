import {
  flushQueue,
  groupOf,
  isMutation,
  mutationsForRows,
  newMutationEntries,
  requestBody,
  type FlushReport,
  type OutboxEntry,
  type OutboxStore,
  type PushResult,
  type SendResult,
  type SyncRow,
} from './outboxQueue';
import { nextHlc } from './sync/deviceClock';

// Device outbox — IndexedDB storage + real fetch around the pure queue in
// lib/outboxQueue.ts (MZY-205; field-level since MZY-206). Every PWA write
// goes through `submitRows`:
//
//   1. the action becomes field mutations stamped with ONE device HLC taken
//      now (the athlete's moment, never delivery time), stored in IndexedDB
//      before any network I/O — closing the app, losing signal, or an expired
//      session can't lose it;
//   2. a flush is attempted immediately; the caller learns whether it reached
//      the server (synced), is waiting (queued: offline / signed out / server
//      hiccup), or was rejected — a rejection during the athlete's own submit
//      is removed and shown inline, as before the outbox existed;
//   3. anything queued is re-flushed on `online`, on app start, when the tab
//      becomes visible, and every 30 s while something is waiting.
//
// Like lib/liveRecordingDb.ts, the IndexedDB-touching code here is integration
// surface (no fake-idb in this repo) and is exercised live in the browser; the
// logic worth testing lives in outboxQueue.ts.

const DB_NAME = 'agon-outbox';
const DB_VERSION = 1; // unchanged: phase-1 entries live in the same store
const STORE = 'mutations';
const LOCK_NAME = 'agon-outbox-flush';
const CHANNEL_NAME = 'agon-outbox';
const RETRY_INTERVAL_MS = 30_000;
const PUSH_ENDPOINT = '/api/sync/push';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () =>
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

const idbStore: OutboxStore & {
  putAll(entries: OutboxEntry[]): Promise<void>;
} = {
  async list() {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const all = await promisifyRequest(
      tx.objectStore(STORE).getAll() as IDBRequest<OutboxEntry[]>,
    );
    return all.sort((a, b) => a.seq - b.seq);
  },
  async put(entry) {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    await promisifyRequest(tx.objectStore(STORE).put(entry));
  },
  /** One transaction: an action's mutations are queued all together or not at all. */
  async putAll(entries) {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    for (const e of entries) tx.objectStore(STORE).put(e);
    await txDone(tx);
  },
  async remove(id) {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    await promisifyRequest(tx.objectStore(STORE).delete(id));
  },
};

async function errorOf(res: Response): Promise<string> {
  const detail = (await res.json().catch(() => ({}))) as { error?: string };
  return detail.error ?? `HTTP ${res.status}`;
}

async function send(batch: OutboxEntry[]): Promise<SendResult> {
  const first = batch[0]!;
  let res: Response;
  try {
    res = isMutation(first)
      ? await fetch(PUSH_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mutations: batch.flatMap((e) =>
              isMutation(e) ? [e.mutation] : [],
            ),
          }),
          credentials: 'same-origin',
        })
      : await fetch(first.endpoint, {
          method: first.method,
          headers: { 'Content-Type': 'application/json' },
          body: requestBody(first),
          credentials: 'same-origin',
        });
  } catch {
    return { status: 'network-error', error: 'offline' };
  }
  if (!res.ok) return { status: res.status, error: await errorOf(res) };
  if (!isMutation(first)) return { status: res.status, error: null };
  const { results } = (await res.json()) as { results: PushResult[] };
  return { status: res.status, error: null, results };
}

// --- change notification (this tab's listeners + other open tabs) ----------

export interface OutboxSnapshot {
  entries: OutboxEntry[];
  /** The last flush hit a 401: queued writes wait for the athlete to sign in. */
  authRequired: boolean;
}

type Listener = (snapshot: OutboxSnapshot) => void;
const listeners = new Set<Listener>();
const deliveryListeners = new Set<() => void>();
let authRequired = false;
let channel: BroadcastChannel | null = null;

async function notify(broadcast = true): Promise<void> {
  const snapshot = { entries: await idbStore.list(), authRequired };
  for (const l of listeners) l(snapshot);
  if (broadcast) channel?.postMessage('changed');
}

export function subscribeOutbox(listener: Listener): () => void {
  listeners.add(listener);
  void notify(false);
  return () => listeners.delete(listener);
}

/**
 * Called after a flush delivered at least one queued write — pages use it to
 * re-fetch, so a meal logged offline appears in the list once it has synced.
 */
export function onOutboxDelivered(callback: () => void): () => void {
  deliveryListeners.add(callback);
  return () => deliveryListeners.delete(callback);
}

// --- flushing ----------------------------------------------------------------

let flushChain: Promise<unknown> = Promise.resolve();

function runFlush(): Promise<FlushReport> {
  const flush = async () => {
    const run = () => flushQueue(idbStore, send);
    // Web Locks: two open tabs never flush at once (the server would dedupe
    // anyway — this just avoids the doubled requests).
    const report: FlushReport =
      typeof navigator !== 'undefined' && navigator.locks
        ? await navigator.locks.request(LOCK_NAME, run)
        : await run();
    if (report.stoppedBy === 'auth') authRequired = true;
    else if (report.delivered.length > 0 || report.stoppedBy === null)
      authRequired = false;
    await notify();
    if (report.delivered.length > 0) {
      for (const cb of deliveryListeners) cb();
      // Another open tab may be showing the list this write belongs to.
      channel?.postMessage('delivered');
    }
    return report;
  };
  // Serialise flushes in this tab: each call gets its own complete pass that
  // starts after any flush already running, so a just-enqueued write is seen.
  const next = flushChain.then(flush, flush);
  flushChain = next.catch(() => undefined);
  return next;
}

/** Every queued (pending or failed) write, for the replica to keep showing it. */
export async function listOutbox(): Promise<OutboxEntry[]> {
  return idbStore.list();
}

export function flushOutbox(): Promise<FlushReport> {
  return runFlush();
}

export type SubmitResult =
  | { state: 'synced' }
  | { state: 'queued'; reason: 'offline' | 'auth' }
  | { state: 'rejected'; error: string };

let seqCounter = 0;

/**
 * Queue one athlete action — rows of field values — then try to deliver it.
 * Row ids are chosen by the caller (crypto.randomUUID() for a new row), so
 * later edits can reference the row before it has ever reached the server.
 */
export async function submitRows(input: {
  label: string;
  rows: SyncRow[];
}): Promise<SubmitResult> {
  const entries = newMutationEntries({
    group: crypto.randomUUID(),
    label: input.label,
    capturedAt: new Date().toISOString(),
    // ms × 1000 (the phase-1 scale, ~1.8e15 — safely below 2^53): room for
    // 10 actions of up to 100 mutations each within one millisecond.
    firstSeq: Date.now() * 1000 + (seqCounter++ % 10) * 100,
    mutations: mutationsForRows(input.rows, nextHlc()),
    newId: () => crypto.randomUUID(),
  });
  if (entries.length === 0) return { state: 'synced' };
  await idbStore.putAll(entries);
  await notify();

  const report = await runFlush();
  const ids = new Set(entries.map((e) => e.id));
  if (report.failed.some((id) => ids.has(id))) {
    // Rejected while the athlete is looking at the form: show the reason
    // there, as before the outbox existed, instead of parking it in the list.
    const stored = (await idbStore.list()).filter((e) => ids.has(e.id));
    for (const e of stored) await idbStore.remove(e.id);
    await notify();
    const error =
      stored.find((e) => e.status === 'failed')?.lastError ??
      'rejected by server';
    return { state: 'rejected', error };
  }
  if (entries.every((e) => report.delivered.includes(e.id)))
    return { state: 'synced' };
  return {
    state: 'queued',
    reason: report.stoppedBy === 'auth' ? 'auth' : 'offline',
  };
}

export async function retryGroup(group: string): Promise<void> {
  for (const e of await idbStore.list()) {
    if (groupOf(e) === group)
      await idbStore.put({ ...e, status: 'pending', lastError: null });
  }
  await runFlush();
}

export async function discardGroup(group: string): Promise<void> {
  for (const e of await idbStore.list()) {
    if (groupOf(e) === group) await idbStore.remove(e.id);
  }
  await notify();
}

// --- lifecycle ---------------------------------------------------------------

let started = false;

/** Idempotent; call once from the root layout on the client. */
export function startOutbox(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  // Ask the browser not to evict our IndexedDB under storage pressure (mobile
  // Safari/Chrome otherwise may, taking queued writes with it). Best effort.
  void navigator.storage?.persist?.().catch(() => undefined);

  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent) => {
      void notify(false);
      if (event.data === 'delivered') for (const cb of deliveryListeners) cb();
    };
  }

  const flushIfWaiting = async () => {
    const entries = await idbStore.list();
    if (entries.some((e) => e.status === 'pending')) await runFlush();
  };
  window.addEventListener('online', () => void flushIfWaiting());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flushIfWaiting();
  });
  window.setInterval(() => void flushIfWaiting(), RETRY_INTERVAL_MS);
  void flushIfWaiting();
}
