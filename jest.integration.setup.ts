import { loadEnv } from './scripts/loadEnv';

// Integration lane DB isolation. The suite used to run against whatever
// DATABASE_URL .env.local held — the athlete's real (and, until MZY-209,
// un-backed-up) dev database. It now always targets a separate `agon_test`
// database on the same server: AGON_TEST_DATABASE_URL if set, otherwise
// .env.local's DATABASE_URL with the database name swapped to `agon_test`.
// Set here, BEFORE any test calls loadEnv(), which never clobbers an
// already-set variable — so every test's own loadEnv() keeps this value.
//
// One-time setup:  docker exec agon-db-1 createdb -U agon agon_test
//                  DATABASE_URL=<...>/agon_test pnpm migrate
loadEnv();
const url = new URL(
  process.env.AGON_TEST_DATABASE_URL || process.env.DATABASE_URL || '',
);
if (!process.env.AGON_TEST_DATABASE_URL) url.pathname = '/agon_test';
if (!url.pathname.endsWith('_test')) {
  throw new Error(
    `integration lane refuses to run against ${url.pathname.slice(1)}: ` +
      'the database name must end in _test',
  );
}
process.env.DATABASE_URL = url.toString();
// The MCP read path (services/mcp/readonlyDb.ts) prefers MCP_DATABASE_URL —
// pin it too, or MCP tool tests would read the real database.
process.env.MCP_DATABASE_URL = url.toString();
