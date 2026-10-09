import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from 'pg';

// The single database access point. Provider-neutral by design: the rest of the
// codebase depends on node-postgres (`pg`) and plain SQL, never on any hosted
// provider's SDK. Swapping the Supabase-vs-plain-Postgres decision (or moving
// the box) is a DATABASE_URL change, not a refactor — this is the one swap point.
//
// One lazily-created pool per process, reused across calls. Scripts must call
// closeDbPool() before exit so the process doesn't hang on the open socket.

let pool: Pool | null = null;

const LOCAL_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  'host.docker.internal',
  'db',
]);

/**
 * Whether a connection should use TLS. Rule: an explicit `sslmode` in the URL
 * wins; otherwise SSL is ON for any remote host and OFF for loopback. This is
 * what makes a Supabase connection string — which typically carries no
 * `sslmode` param — get TLS automatically, while the local Docker Postgres
 * stays plaintext. Shared with scripts/migrate.ts so both agree.
 */
export function connectionNeedsSsl(connectionString: string): boolean {
  if (/sslmode=disable/.test(connectionString)) return false;
  if (/sslmode=(require|verify-ca|verify-full)/.test(connectionString)) {
    return true;
  }
  try {
    return !LOCAL_HOSTS.has(new URL(connectionString).hostname);
  } catch {
    return false;
  }
}

function sslConfig(url: string): { rejectUnauthorized: boolean } | undefined {
  // rejectUnauthorized:false encrypts without verifying the chain — pragmatic
  // for both Supabase's pooler and a self-hosted VPS cert, and adequate for a
  // single-user app. Tighten to a pinned CA if this ever goes multi-user.
  return connectionNeedsSsl(url) ? { rejectUnauthorized: false } : undefined;
}

export function getDbPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('getDbPool: expected DATABASE_URL, got undefined');
  }
  pool = new Pool({
    connectionString,
    ssl: sslConfig(connectionString),
    max: 5,
  });
  return pool;
}

export async function closeDbPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Convenience query helper over the shared pool. */
export function query<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
): Promise<QueryResult<Row>> {
  return getDbPool().query<Row>(text, params as unknown[]);
}

/** Run a function inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
