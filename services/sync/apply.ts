import type { PoolClient } from 'pg';
import { withTransaction } from '../db';
import { clampHlc, formatHlc, isHlc, parseHlc, tickHlc, type Hlc } from '@/lib/sync/hlc';
import { mergeRow, type FieldStamps, type FieldWrite, type Origin } from '@/lib/sync/mergeField';
import { isSyncTable, syncTable, type SyncTableName } from '@/lib/sync/schema';

// The server's write path for replicated tables (MZY-206). Every field-level
// write — pushed by a PWA device, or made server-side by the lab-PDF import —
// goes through here and is decided by the pure mergeField()/mergeRow().
//
// One transaction per batch:
//   - takes the same advisory lock as the sync_stamp trigger (sync_seq order
//     = commit order) and sets agon.sync_apply so the trigger leaves our
//     field_hlc alone;
//   - validates each mutation against the lib/sync/schema.ts whitelist
//     (a bad mutation is rejected on its own, the batch carries on);
//   - resolves ids through sync_id_aliases, then per row: merge into the
//     existing row, or create it — and if the create hits a natural key
//     that already exists, record an alias and merge into that row instead
//     (MZY-206 decision 2);
//   - each row runs under a savepoint, so a constraint/FK failure rejects
//     that row's mutations and nothing else.
// Idempotent: a replayed mutation carries the same HLC, which mergeField
// treats as "no change".

export interface FieldMutation {
  table: string;
  id: string;
  field: string;
  value: unknown;
  hlc: string;
  origin: Origin;
}

export type MutationStatus = 'applied' | 'skipped' | 'rejected';

export interface MutationResult {
  status: MutationStatus;
  error?: string;
  /** Set when the row id was aliased onto an existing natural-key row. */
  canonicalId?: string;
}

export interface ApplyOptions {
  /** Allow writes to tables devices may not push (server-side writers). */
  serverWriter?: boolean;
  nowMs?: number;
  /** Stamps further ahead of server time than this are clamped (clampHlc). */
  maxDriftMs?: number;
}

const DEFAULT_MAX_DRIFT_MS = 10 * 60_000;
const BOOKKEEPING = new Set(['id', 'created_at', 'updated_at', 'sync_seq', 'field_hlc', 'edit_origin']);

interface PreparedRow {
  table: SyncTableName;
  id: string;
  writes: (FieldWrite & { index: number })[];
}

function prepare(
  mutations: FieldMutation[],
  results: MutationResult[],
  opts: Required<Pick<ApplyOptions, 'nowMs' | 'maxDriftMs'>> & ApplyOptions,
): PreparedRow[] {
  const rows = new Map<string, PreparedRow>();
  mutations.forEach((m, index) => {
    const reject = (error: string) => (results[index] = { status: 'rejected', error });
    if (!isSyncTable(m.table)) return reject(`table "${m.table}" is not replicated`);
    const spec = syncTable(m.table);
    if (!spec.pushable && !opts.serverWriter) return reject(`table "${m.table}" is read-only for devices`);
    const schema = spec.fields[m.field];
    if (!schema || BOOKKEEPING.has(m.field)) return reject(`field "${m.table}.${m.field}" is not syncable`);
    const parsed = schema.safeParse(m.value);
    if (!parsed.success) return reject(`invalid value for ${m.table}.${m.field}: ${parsed.error.issues[0]?.message}`);
    if (!isHlc(m.hlc)) return reject('invalid hlc');
    if (m.origin !== 'human' && m.origin !== 'machine') return reject('invalid origin');

    const key = `${m.table}:${m.id}`;
    const row = rows.get(key) ?? { table: m.table, id: m.id, writes: [] };
    row.writes.push({
      index,
      field: m.field,
      value: parsed.data,
      stamp: { hlc: clampHlc(m.hlc, opts.nowMs, opts.maxDriftMs), origin: m.origin },
    });
    rows.set(key, row);
  });
  return [...rows.values()]; // Map keeps first-appearance order: parents before children
}

async function resolveAlias(client: PoolClient, id: string): Promise<string> {
  const { rows } = await client.query<{ canonical_id: string }>(
    'SELECT canonical_id FROM public.sync_id_aliases WHERE alias_id = $1',
    [id],
  );
  return rows[0]?.canonical_id ?? id;
}

function lastValues(writes: FieldWrite[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const w of writes) out[w.field] = w.value;
  return out;
}

async function hasUpdatedAt(client: PoolClient, table: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'updated_at'`,
    [table],
  );
  return rows.length > 0;
}

async function updateRow(
  client: PoolClient,
  row: PreparedRow,
  id: string,
  current: FieldStamps,
  results: MutationResult[],
  canonicalId?: string,
): Promise<void> {
  const merged = mergeRow(current, row.writes);
  row.writes.forEach((w, i) => {
    results[w.index] = {
      status: merged.accepted[i] ? 'applied' : 'skipped',
      ...(canonicalId ? { canonicalId } : {}),
    };
  });
  const fields = Object.keys(merged.apply);
  if (fields.length === 0) return;

  const sets = fields.map((f, i) => `${quoteIdent(f)} = $${i + 2}`);
  sets.push(`field_hlc = $${fields.length + 2}`);
  sets.push(`edit_origin = $${fields.length + 3}`);
  if (await hasUpdatedAt(client, row.table)) sets.push('updated_at = now()');
  const lastOrigin = row.writes.filter((w) => w.field in merged.apply).at(-1)!.stamp.origin;
  await client.query(
    `UPDATE public.${quoteIdent(row.table)} SET ${sets.join(', ')} WHERE id = $1`,
    [id, ...fields.map((f) => merged.apply[f]), JSON.stringify(merged.stamps), lastOrigin],
  );
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad identifier ${name}`);
  return `"${name}"`;
}

async function applyRow(client: PoolClient, row: PreparedRow, results: MutationResult[]): Promise<void> {
  const spec = syncTable(row.table);
  const id = await resolveAlias(client, row.id);
  const aliased = id !== row.id ? id : undefined;

  // FK values pointing at replicated rows may themselves be aliases.
  for (const w of row.writes) {
    if (w.field in spec.refs && typeof w.value === 'string') w.value = await resolveAlias(client, w.value);
  }

  const table = quoteIdent(row.table);
  const existing = await client.query<{ field_hlc: FieldStamps }>(
    `SELECT field_hlc FROM public.${table} WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (existing.rows[0]) {
    await updateRow(client, row, id, existing.rows[0].field_hlc, results, aliased);
    return;
  }

  const values = lastValues(row.writes);
  const missing = spec.required.filter((f) => values[f] === undefined || values[f] === null);
  if (missing.length > 0) {
    for (const w of row.writes) {
      results[w.index] = { status: 'rejected', error: `row ${row.id} does not exist; creating it needs ${missing.join(', ')}` };
    }
    return;
  }

  if (spec.naturalKey) {
    const conds = spec.naturalKey.map((f, i) => `${quoteIdent(f)} = $${i + 1}`).join(' AND ');
    const found = await client.query<{ id: string; field_hlc: FieldStamps }>(
      `SELECT id, field_hlc FROM public.${table} WHERE ${conds} FOR UPDATE`,
      spec.naturalKey.map((f) => values[f]),
    );
    const match = found.rows[0];
    if (match) {
      await client.query(
        `INSERT INTO public.sync_id_aliases (alias_id, table_name, canonical_id) VALUES ($1, $2, $3)
         ON CONFLICT (alias_id) DO NOTHING`,
        [row.id, row.table, match.id],
      );
      await updateRow(client, row, match.id, match.field_hlc, results, match.id);
      return;
    }
  }

  const merged = mergeRow({}, row.writes);
  const fields = Object.keys(merged.apply);
  const firstWall = Math.min(...row.writes.map((w) => parseHlc(w.stamp.hlc).wall));
  const cols = ['id', ...fields.map(quoteIdent), 'field_hlc', 'edit_origin', 'created_at'];
  const params = [
    id,
    ...fields.map((f) => merged.apply[f]),
    JSON.stringify(merged.stamps),
    row.writes.at(-1)!.stamp.origin,
    new Date(firstWall).toISOString(), // created when the athlete acted, on the device clock
  ];
  await client.query(
    `INSERT INTO public.${table} (${cols.join(', ')}) VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')})`,
    params,
  );
  row.writes.forEach((w, i) => {
    results[w.index] = { status: merged.accepted[i] ? 'applied' : 'skipped' };
  });
}

/** Apply a batch of field-level mutations. Never throws for a bad mutation — see results. */
export async function applyMutations(
  mutations: FieldMutation[],
  options: ApplyOptions = {},
): Promise<MutationResult[]> {
  const opts = {
    ...options,
    nowMs: options.nowMs ?? Date.now(),
    maxDriftMs: options.maxDriftMs ?? DEFAULT_MAX_DRIFT_MS,
  };
  const results: MutationResult[] = new Array(mutations.length);
  const rows = prepare(mutations, results, opts);
  if (rows.length === 0) return results;

  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('agon.sync_seq'))");
    await client.query("SELECT set_config('agon.sync_apply', 'on', true)");
    for (const [n, row] of rows.entries()) {
      await client.query(`SAVEPOINT row_${n}`);
      try {
        await applyRow(client, row, results);
        await client.query(`RELEASE SAVEPOINT row_${n}`);
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT row_${n}`);
        const error = err instanceof Error ? err.message : String(err);
        for (const w of row.writes) results[w.index] = { status: 'rejected', error };
      }
    }
  });
  return results;
}

// --- server-side writers (lab-PDF import; Calendar reconcile in phase 4) ----

let serverClock: Hlc | null = null;

/** A fresh HLC for a write made by this server process as `node`. */
export function serverHlc(node: string, nowMs: number = Date.now()): string {
  serverClock = tickHlc(serverClock, nowMs, node);
  return formatHlc(serverClock);
}

/** Field mutations for one row, all stamped with one server HLC. */
export function rowMutations(
  table: SyncTableName,
  id: string,
  values: Record<string, unknown>,
  origin: Origin,
  node: string,
): FieldMutation[] {
  const hlc = serverHlc(node);
  return Object.entries(values)
    .filter(([, v]) => v !== undefined)
    .map(([field, value]) => ({ table, id, field, value, hlc, origin }));
}
