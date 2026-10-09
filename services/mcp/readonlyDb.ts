import { Pool } from 'pg';
import { connectionNeedsSsl } from '../db';

// Read-only DB access for the MCP consulting layer. Isolated from services/db.ts
// on purpose: its own pool, its own connection string, and — crucially — every
// statement runs inside a `READ ONLY` transaction with a statement timeout. That
// makes writes impossible at the DB level regardless of the role's grants
// (defense in depth alongside the mcp_reader role), and caps runaway scans.

const STATEMENT_TIMEOUT_MS = 15_000;

let pool: Pool | null = null;

function connectionString(): string {
  // Prefer a dedicated read-only URL (point it at the mcp_reader role in prod);
  // fall back to DATABASE_URL for local dev where the READ ONLY txn is the guard.
  const url = process.env.MCP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'mcp: MCP_DATABASE_URL or DATABASE_URL must be set for the consulting layer',
    );
  }
  return url;
}

function getPool(): Pool {
  if (pool) return pool;
  const url = connectionString();
  pool = new Pool({
    connectionString: url,
    ssl: connectionNeedsSsl(url) ? { rejectUnauthorized: false } : undefined,
    max: 4,
  });
  return pool;
}

export async function closeReadPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Run a single read-only SELECT/CTE and return its rows. Enforced read-only via
 * a `READ ONLY` transaction; a per-statement timeout bounds cost. Callers must
 * pass a single statement (the SQL tool validates this upstream).
 */
export async function readQuery<Row = Record<string, unknown>>(
  sql: string,
  params?: readonly unknown[],
): Promise<Row[]> {
  const client = await getPool().connect();
  try {
    await client.query('START TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const res = await client.query(sql, params as unknown[]);
    await client.query('COMMIT');
    return res.rows as Row[];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
