import { spawn } from 'child_process';
import { closeSync, createWriteStream, openSync, renameSync } from 'fs';

// Shared plumbing for scripts/backup-db.ts and scripts/restore-drill.ts
// (MZY-209). Both shell into the running Postgres container with
// `docker exec` rather than `docker compose ...`: compose resolves its
// project from the working directory, and running it from the wrong
// directory is how the 2026-09-08 volume deletion happened (MZY-113).
// `docker exec` against a named container can't touch volumes at all.

export interface DbTarget {
  container: string;
  user: string;
  database: string;
}

export function dbTarget(): DbTarget {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (.env.local)');
  const parsed = new URL(url);
  return {
    container: process.env.AGON_DB_CONTAINER || 'agon-db-1',
    user: decodeURIComponent(parsed.username),
    database: parsed.pathname.replace(/^\//, ''),
  };
}

// The Docker CLI picks its engine from the current context. After installing
// Docker Desktop a scheduler's clean environment resolves to `desktop-linux`,
// an engine without the agon container, and `docker exec` fails with "no such
// container" (MZY-401). AGON_DOCKER_HOST names the engine explicitly; it is
// separate from DOCKER_HOST so a value in .env.local cannot also redirect
// `docker compose` runs from the same shell.
const DOCKER_HOST_FORM = /^(unix|tcp|ssh):\/\/\S+$/;

type Env = Record<string, string | undefined>;

export function dockerArgs(args: string[], env: Env = process.env): string[] {
  const host = env.AGON_DOCKER_HOST;
  if (!host) return args;
  if (!DOCKER_HOST_FORM.test(host))
    throw new Error(
      `AGON_DOCKER_HOST must look like unix:///var/run/docker.sock, tcp://host:2375 or ssh://user@host; got "${host}"`,
    );
  return ['--host', host, ...args];
}

// Run a command; resolve with stdout, reject with stderr on non-zero exit.
interface RunOpts {
  stdoutFile?: string;
  stdinFile?: string;
  env?: Env;
}

export function run(
  cmd: string,
  args: string[],
  opts: RunOpts = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdinFd = opts.stdinFile ? openSync(opts.stdinFile, 'r') : null;
    const child = spawn(cmd, args, {
      stdio: [stdinFd ?? 'ignore', 'pipe', 'pipe'],
      env: opts.env as NodeJS.ProcessEnv | undefined,
    });
    const { stdout, stderr } = child as unknown as {
      stdout: NodeJS.ReadableStream;
      stderr: NodeJS.ReadableStream;
    }; // both 'pipe' above, so never null
    let out = '';
    let err = '';
    // With a stdout file, the child's 'close' can fire before the file
    // stream has flushed — wait for the stream's 'finish' too, or the
    // verify step would read a truncated dump.
    const flushed = new Promise<void>((done, fail) => {
      if (!opts.stdoutFile) return done();
      const file = createWriteStream(opts.stdoutFile);
      file.on('finish', done).on('error', fail);
      stdout.pipe(file);
    });
    if (!opts.stdoutFile)
      stdout.on('data', (b: Buffer) => (out += b.toString()));
    stderr.on('data', (b: Buffer) => (err += b.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (stdinFd !== null) closeSync(stdinFd);
      if (code !== 0) {
        reject(
          new Error(`${cmd} ${args.join(' ')} exited ${code}: ${err.trim()}`),
        );
        return;
      }
      flushed.then(() => resolve(out), reject);
    });
  });
}

export async function docker(
  args: string[],
  opts: RunOpts = {},
): Promise<string> {
  return run('docker', dockerArgs(args, opts.env ?? process.env), opts);
}

export function psql(
  t: DbTarget,
  database: string,
  sql: string,
): Promise<string> {
  return docker([
    'exec',
    t.container,
    'psql',
    '-U',
    t.user,
    '-d',
    database,
    '-v',
    'ON_ERROR_STOP=1',
    '-At',
    '-c',
    sql,
  ]);
}

// Exact row count of every base table outside the system schemas (public
// plus the dbt schemas), as `schema.table -> count`.
// Exact (count(*)), not pg_class.reltuples: the drill compares these for
// equality, and estimates would make it pass or fail at random.
export async function exactRowCounts(
  t: DbTarget,
  database: string,
): Promise<Map<string, number>> {
  const tables = (
    await psql(
      t,
      database,
      "SELECT schemaname || '.' || tablename FROM pg_tables " +
        "WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1",
    )
  )
    .split('\n')
    .filter(Boolean);
  const counts = new Map<string, number>();
  if (tables.length === 0) return counts;
  const union = tables
    .map((tb) => {
      const [schema, table] = tb.split('.');
      return `SELECT '${tb}', count(*) FROM "${schema}"."${table}"`;
    })
    .join(' UNION ALL ');
  for (const line of (await psql(t, database, union))
    .split('\n')
    .filter(Boolean)) {
    const [name, n] = line.split('|');
    if (name) counts.set(name, Number(n));
  }
  return counts;
}

// pg_dump (custom format) to `file`, then prove the archive is readable by
// listing its table of contents. Writes to `<file>.partial` and renames only
// after verification, so a crash mid-dump never leaves a truncated file
// that rotation would count as a good backup.
export async function takeVerifiedDump(
  t: DbTarget,
  file: string,
): Promise<number> {
  const partial = `${file}.partial`;
  await docker(
    ['exec', t.container, 'pg_dump', '-U', t.user, '-d', t.database, '-Fc'],
    { stdoutFile: partial },
  );
  const toc = await docker(['exec', '-i', t.container, 'pg_restore', '-l'], {
    stdinFile: partial,
  });
  const tableData = toc
    .split('\n')
    .filter((l) => l.includes(' TABLE DATA ')).length;
  if (tableData === 0)
    throw new Error(`dump ${partial} has no TABLE DATA entries`);
  renameSync(partial, file);
  return tableData;
}
