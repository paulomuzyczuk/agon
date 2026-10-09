import { readQuery } from './readonlyDb';

// The read-only SQL escape hatch + schema introspection. The READ ONLY
// transaction in readonlyDb.ts is the real write-guard; this layer adds
// single-statement + SELECT/WITH validation (nicer errors than a raw PG failure)
// and a row cap so an unbounded query can't flood the model's context.

const MAX_ROWS = 500;

// Tables the consulting layer must never read — OAuth refresh tokens. Denied at
// the app layer so even the local DATABASE_URL fallback (which may be a
// privileged role) can't be coaxed into leaking secrets; the mcp_reader role
// also revokes them at the DB level.
export const DENIED_TABLES = [
  'google_health_oauth_tokens',
  'google_calendar_oauth_tokens',
];

export interface SqlValidation {
  ok: boolean;
  sql?: string; // normalized (trailing semicolon stripped)
  error?: string;
}

/**
 * Pure validation: exactly one statement, it must be a SELECT or WITH, and it
 * must not reference a denied (secret) table. A data-modifying CTE
 * (`WITH x AS (INSERT …)`) still passes the SELECT/WITH gate but is rejected at
 * runtime by the READ ONLY transaction — this is only the first gate.
 */
export function validateReadOnlySql(input: string): SqlValidation {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: 'empty query' };
  const noTrailing = trimmed.replace(/;\s*$/, '');
  if (noTrailing.includes(';')) {
    return {
      ok: false,
      error: 'only a single statement is allowed (found `;`)',
    };
  }
  if (!/^\s*(select|with)\b/i.test(noTrailing)) {
    return {
      ok: false,
      error: 'only read-only SELECT / WITH queries are allowed',
    };
  }
  const lowered = noTrailing.toLowerCase();
  for (const t of DENIED_TABLES) {
    if (new RegExp(`\\b${t}\\b`).test(lowered)) {
      return { ok: false, error: `access to '${t}' is not permitted` };
    }
  }
  return { ok: true, sql: noTrailing };
}

export interface SqlResult {
  rows: Record<string, unknown>[];
  rowCount: number; // rows the query produced
  truncated: boolean; // true if capped to MAX_ROWS
}

/** Validate + run a read-only query, capping the returned rows. */
export async function runReadOnlySql(input: string): Promise<SqlResult> {
  const v = validateReadOnlySql(input);
  if (!v.ok || !v.sql) throw new Error(v.error ?? 'invalid query');
  const rows = await readQuery<Record<string, unknown>>(v.sql);
  const truncated = rows.length > MAX_ROWS;
  return {
    rows: truncated ? rows.slice(0, MAX_ROWS) : rows,
    rowCount: rows.length,
    truncated,
  };
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
}

/** Compact markdown of every public table + its columns, for the model to plan SQL. */
export async function describeSchema(): Promise<string> {
  const rows = await readQuery<ColumnRow>(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name <> ALL($1)
      ORDER BY table_name, ordinal_position`,
    [DENIED_TABLES],
  );

  const byTable = new Map<string, string[]>();
  for (const r of rows) {
    const nullable = r.is_nullable === 'YES' ? '' : ' NOT NULL';
    const col = `${r.column_name} ${r.data_type}${nullable}`;
    const list = byTable.get(r.table_name) ?? [];
    list.push(col);
    byTable.set(r.table_name, list);
  }

  // Athlete-authored tables sync across devices (MZY-206) and delete softly:
  // a deleted row stays, with deleted_at set, so the delete can replicate.
  const sections: string[] = [
    '**Soft deletes:** tables with a `deleted_at` column keep deleted rows as ' +
      'tombstones. Always add `deleted_at IS NULL` (per table, including joined ' +
      'ones) unless you are asking about deletions.',
  ];
  for (const [table, cols] of byTable) {
    sections.push(`### ${table}\n${cols.map((c) => `- ${c}`).join('\n')}`);
  }
  return sections.join('\n\n');
}
