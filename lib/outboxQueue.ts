// Device outbox — the pure queue logic (MZY-205, field-level since MZY-206).
//
// Generalises the write-ahead idea of lib/liveRecordingDb.ts from "HR samples
// of one recording" to "any PWA write": the write is persisted on the device
// FIRST, then delivered to the server whenever the network allows, and only
// removed once the server has acknowledged it.
//
// Since phase 2 every write is a set of FIELD mutations
// ({table, id, field, value, hlc, origin}) pushed in batches to
// POST /api/sync/push, which merges each with mergeField() and answers per
// mutation. One athlete action (log a meal, fix a quantity, undo) is one
// `group` of entries sharing a label and an HLC.
//
// Entries queued by a phase-1 build (one HTTP request each, no `kind`) are
// still delivered as-is, so upgrading never drops an offline write.
//
// Everything here is storage- and network-agnostic: `flushQueue` takes an
// `OutboxStore` and a `send` function, so the whole algorithm is unit-tested
// with in-memory fakes. lib/outbox.ts supplies IndexedDB and fetch.

export type OutboxStatus = 'pending' | 'failed';

export interface FieldMutation {
  table: string;
  id: string;
  field: string;
  value: unknown;
  hlc: string;
  origin: 'human' | 'machine';
}

interface EntryBase {
  /** Unique per entry. For request entries it is also the clientId sent. */
  id: string;
  /** Enqueue order. Delivery is strictly FIFO (a delete must follow its create). */
  seq: number;
  /** When the athlete acted, device clock (ISO). Never the delivery time. */
  capturedAt: string;
  /** Human description for the pending/failed list, e.g. "Meal: breakfast". */
  label: string;
  attempts: number;
  status: OutboxStatus;
  lastError: string | null;
}

export interface MutationEntry extends EntryBase {
  kind: 'mutation';
  /** All entries from one athlete action share a group. */
  group: string;
  mutation: FieldMutation;
}

/** A phase-1 (MZY-205) entry: one whole HTTP request. Only ever drained. */
export interface RequestEntry extends EntryBase {
  kind?: 'request';
  endpoint: string;
  method: 'POST' | 'DELETE';
  body: Record<string, unknown> | null;
}

export type OutboxEntry = MutationEntry | RequestEntry;

export function isMutation(e: OutboxEntry): e is MutationEntry {
  return e.kind === 'mutation';
}

export function groupOf(e: OutboxEntry): string {
  return isMutation(e) ? e.group : e.id;
}

/**
 * What one delivery attempt means at the HTTP level:
 *   done    server accepted the request (2xx)
 *   retry   transient (offline, timeout, 5xx, 429) → keep, stop this flush
 *   auth    session expired (401) → keep, stop, ask the athlete to sign in
 *   failed  the server rejected it (other 4xx) → park as failed, continue
 */
export type FlushOutcome = 'done' | 'retry' | 'auth' | 'failed';

export function classifyResponse(
  status: number | 'network-error',
): FlushOutcome {
  if (status === 'network-error') return 'retry';
  if (status >= 200 && status < 300) return 'done';
  if (status === 401) return 'auth';
  if (status === 408 || status === 425 || status === 429 || status >= 500)
    return 'retry';
  return 'failed';
}

/**
 * `retry` and `auth` stop the flush so later entries never overtake an earlier
 * one: a queued "undo meal" delivered before its "log meal" would delete
 * nothing, and the meal would then appear anyway. A permanently `failed`
 * entry doesn't block the rest — waiting would never make it succeed.
 */
export function shouldContinue(outcome: FlushOutcome): boolean {
  return outcome === 'done' || outcome === 'failed';
}

/** Deliverable entries, FIFO. Failed ones wait for the athlete to retry or discard. */
export function flushOrder(entries: OutboxEntry[]): OutboxEntry[] {
  return entries
    .filter((e) => e.status === 'pending')
    .sort((a, b) => a.seq - b.seq);
}

/**
 * Split the deliverable entries into requests: consecutive mutation entries
 * share one push (up to `batchSize`); a legacy request entry goes alone.
 * Order is preserved across batches.
 */
export function flushBatches(
  entries: OutboxEntry[],
  batchSize: number,
): OutboxEntry[][] {
  const batches: OutboxEntry[][] = [];
  let current: MutationEntry[] = [];
  for (const e of flushOrder(entries)) {
    if (isMutation(e)) {
      current.push(e);
      if (current.length === batchSize) {
        batches.push(current);
        current = [];
      }
    } else {
      if (current.length) batches.push(current);
      current = [];
      batches.push([e]);
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

/** The body of a legacy request entry: stored body plus clientId + capturedAt. */
export function requestBody(entry: RequestEntry): string | undefined {
  if (entry.method === 'DELETE' && entry.body === null) return undefined;
  return JSON.stringify({
    ...entry.body,
    clientId: entry.id,
    capturedAt: entry.capturedAt,
  });
}

export interface SyncRow {
  table: string;
  id: string;
  values: Record<string, unknown>;
}

/** One field mutation per value, all stamped with the action's HLC. */
export function mutationsForRows(
  rows: SyncRow[],
  hlc: string,
): FieldMutation[] {
  return rows.flatMap((r) =>
    Object.entries(r.values)
      .filter(([, v]) => v !== undefined)
      .map(([field, value]) => ({
        table: r.table,
        id: r.id,
        field,
        value,
        hlc,
        origin: 'human' as const,
      })),
  );
}

export function newMutationEntries(input: {
  group: string;
  label: string;
  capturedAt: string;
  firstSeq: number;
  mutations: FieldMutation[];
  newId: () => string;
}): MutationEntry[] {
  return input.mutations.map((mutation, i) => ({
    kind: 'mutation',
    id: input.newId(),
    seq: input.firstSeq + i,
    group: input.group,
    label: input.label,
    capturedAt: input.capturedAt,
    mutation,
    attempts: 0,
    status: 'pending',
    lastError: null,
  }));
}

export interface OutboxStore {
  list(): Promise<OutboxEntry[]>;
  put(entry: OutboxEntry): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Per-mutation verdicts from /api/sync/push. */
export interface PushResult {
  status: 'applied' | 'skipped' | 'rejected';
  error?: string;
}

export interface SendResult {
  status: number | 'network-error';
  error: string | null;
  /** For a push: one result per mutation, in order (2xx only). */
  results?: PushResult[];
}

export type Send = (batch: OutboxEntry[]) => Promise<SendResult>;

export interface FlushReport {
  delivered: string[];
  failed: string[];
  /** Why the flush stopped early, if it did. */
  stoppedBy: 'retry' | 'auth' | null;
}

/** Deliver pending entries in order until something must wait. */
export async function flushQueue(
  store: OutboxStore,
  send: Send,
  batchSize = 200,
): Promise<FlushReport> {
  const report: FlushReport = { delivered: [], failed: [], stoppedBy: null };
  const markFailed = async (e: OutboxEntry, error: string | null) => {
    await store.put({
      ...e,
      attempts: e.attempts + 1,
      status: 'failed',
      lastError: error,
    });
    report.failed.push(e.id);
  };

  for (const batch of flushBatches(await store.list(), batchSize)) {
    const result = await send(batch);
    const outcome = classifyResponse(result.status);

    if (outcome === 'done') {
      for (const [i, e] of batch.entries()) {
        const verdict = result.results?.[i];
        if (isMutation(e) && verdict?.status === 'rejected') {
          await markFailed(e, verdict.error ?? 'rejected');
        } else {
          await store.remove(e.id); // applied, or skipped (lost the merge / replay): final
          report.delivered.push(e.id);
        }
      }
      continue;
    }
    if (outcome === 'failed') {
      for (const e of batch) await markFailed(e, result.error);
      continue;
    }
    for (const e of batch)
      await store.put({
        ...e,
        attempts: e.attempts + 1,
        lastError: result.error,
      });
    report.stoppedBy = outcome as 'retry' | 'auth';
    break;
  }
  return report;
}

export interface OutboxGroup {
  group: string;
  label: string;
  capturedAt: string;
  entryIds: string[];
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
}

/** One line per athlete action for the status bar; failed if any part failed. */
export function groupEntries(entries: OutboxEntry[]): OutboxGroup[] {
  const groups = new Map<string, OutboxGroup>();
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    const key = groupOf(e);
    const g = groups.get(key) ?? {
      group: key,
      label: e.label,
      capturedAt: e.capturedAt,
      entryIds: [],
      status: 'pending' as OutboxStatus,
      attempts: 0,
      lastError: null,
    };
    g.entryIds.push(e.id);
    g.attempts = Math.max(g.attempts, e.attempts);
    if (e.status === 'failed') {
      g.status = 'failed';
      g.lastError = e.lastError;
    } else if (g.status !== 'failed' && e.lastError) {
      g.lastError = e.lastError;
    }
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** Pending mutation entries folded back into rows (in order), for re-laying over a pulled replica. */
export function pendingRows(entries: OutboxEntry[]): SyncRow[] {
  const rows = new Map<string, SyncRow>();
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    if (!isMutation(e)) continue;
    const key = `${e.mutation.table}:${e.mutation.id}`;
    const row = rows.get(key) ?? {
      table: e.mutation.table,
      id: e.mutation.id,
      values: {},
    };
    row.values[e.mutation.field] = e.mutation.value;
    rows.set(key, row);
  }
  return [...rows.values()];
}
