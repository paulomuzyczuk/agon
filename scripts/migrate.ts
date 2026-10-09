import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { Client } from 'pg';
import { loadEnv } from './loadEnv';
import { connectionNeedsSsl } from '../services/db';
import { logger } from '../services/logger';

// Minimal forward-only migration runner (see migrations/README.md). Deliberately
// dependency-light: reads migrations/*.sql in filename order, applies any not yet
// recorded in public.schema_migrations, each inside its own transaction. A
// failure rolls that file back and aborts; a re-run is a no-op.
//
//   pnpm migrate            apply all pending
//   pnpm migrate --status   report applied vs pending, change nothing

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // timestamp prefix makes lexical order == chronological order
}

async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedVersions(client: Client): Promise<Set<string>> {
  const { rows } = await client.query<{ version: string }>(
    'SELECT version FROM public.schema_migrations',
  );
  return new Set(rows.map((r) => r.version));
}

async function main(): Promise<void> {
  loadEnv();
  const statusOnly = process.argv.includes('--status');

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('migrate: expected DATABASE_URL, got undefined');
  }

  const client = new Client({
    connectionString,
    ssl: connectionNeedsSsl(connectionString)
      ? { rejectUnauthorized: false }
      : undefined,
  });
  await client.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await appliedVersions(client);
    const all = migrationFiles();
    const pending = all.filter((f) => !applied.has(f));

    if (statusOnly) {
      logger.info('migration status', {
        job: 'migrate',
        applied: all.length - pending.length,
        pending: pending.length,
      });
      for (const f of all) {
        // eslint-disable-next-line no-console
        console.log(`${applied.has(f) ? '  applied' : '  PENDING'}  ${f}`);
      }
      return;
    }

    if (pending.length === 0) {
      logger.info('no pending migrations', { job: 'migrate' });
      return;
    }

    for (const file of pending) {
      const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf-8');
      logger.info('applying migration', { job: 'migrate', file });
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO public.schema_migrations (version) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error(
          'migration failed — rolled back',
          { job: 'migrate', file },
          err,
        );
        throw err;
      }
    }
    logger.info('migrations applied', {
      job: 'migrate',
      count: pending.length,
    });
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  logger.error('migrate: aborted', { job: 'migrate' }, err);
  process.exit(1);
});
