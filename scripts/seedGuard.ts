// Seed/destructive-script production guard (sihha "Guard-rails worth copying").
// Root cause it closes at sihha: scripts read env and silently defaulted to the
// REMOTE database, and a dummy-data script was once run against production that
// way. Every seed/dummy/reset script calls assertLocalTarget() right after
// loading env, so hitting a remote database is an explicit decision, never a
// default.
//
// Agon connects via a single DATABASE_URL (node-postgres), so the check is on
// that URL's host rather than sihha's Supabase URL.

const LOCAL_DB_HOSTNAMES = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  // Docker-for-Mac/Windows loopback alias, for scripts run inside a container
  'host.docker.internal',
  // docker-compose service name, when a script runs in the same compose network
  'db',
]);

/**
 * Refuses to proceed unless DATABASE_URL points at a local Postgres, or
 * ALLOW_REMOTE_SEED=1 explicitly authorizes a remote run. Pass `env` explicitly
 * in tests; scripts use the process default.
 *
 * NOTE: this is for SEED / DUMMY / RESET scripts. Real ingestion jobs
 * (e.g. scripts/backfill-strava.ts) legitimately write to the production
 * database and deliberately do NOT call this.
 */
export function assertLocalTarget(
  scriptName: string,
  env: Record<string, string | undefined> = process.env,
): void {
  const url = env.DATABASE_URL;
  let hostname: string;
  try {
    hostname = new URL(url ?? '').hostname;
  } catch {
    throw new Error(
      `${scriptName}: DATABASE_URL is missing or not a valid URL ` +
        `(got ${JSON.stringify(url ?? null)}) — cannot tell local from remote, refusing to seed`,
    );
  }
  if (LOCAL_DB_HOSTNAMES.has(hostname)) return;
  if (env.ALLOW_REMOTE_SEED === '1') {
    console.warn(
      `${scriptName}: ALLOW_REMOTE_SEED=1 set — seeding REMOTE Postgres at ${hostname}`,
    );
    return;
  }
  throw new Error(
    `${scriptName}: DATABASE_URL points at ${hostname}, which is not a local ` +
      `Postgres. Seed/dummy scripts refuse remote targets by default (a dummy ` +
      `script once hit production this way). If this remote run is intentional, ` +
      `set ALLOW_REMOTE_SEED=1 on the command line.`,
  );
}
