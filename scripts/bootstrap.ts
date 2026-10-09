import { existsSync, copyFileSync, appendFileSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';

// One-command self-hosting bootstrap (self-hosting decision — see CLAUDE.md
// "Bootstrap flow"). Scoped to what can actually be automated: scaffolding
// config from the committed *.example.* templates, generating secrets that
// don't need a human to choose them, and standing up the database. It
// deliberately does NOT run any seed script (seed:planned, seed:foods, ...) —
// those need the personal config files filled in with REAL values first;
// auto-seeding placeholder data would plant garbage in a fresh self-hoster's
// database. It also does NOT touch OAuth — every integration needs its own
// vendor console click-through, which cannot be scripted (same position as
// the sibling Hephaistos project's "every self-hoster creates their own OAuth
// app").
//
//   pnpm bootstrap

const ROOT = process.cwd();

function copyIfAbsent(src: string, dest: string): 'created' | 'skipped' {
  const destPath = resolve(ROOT, dest);
  if (existsSync(destPath)) return 'skipped';
  copyFileSync(resolve(ROOT, src), destPath);
  return 'created';
}

/**
 * The real value of an env-file line, with any trailing inline comment
 * stripped (`VAR=            # note` → `''`) — mirrors scripts/loadEnv.ts's
 * own comment-stripping exactly, so "is this var already set" agrees with
 * what loadEnv() will actually load at runtime. Returns null if `varName`
 * isn't declared at all.
 */
function envLineValue(contents: string, varName: string): string | null {
  const match = contents.match(new RegExp(`^${varName}=(.*)$`, 'm'));
  if (!match) return null;
  const rawVal = match[1] ?? '';
  const commentMatch = rawVal.match(/\s#.*$/);
  return (commentMatch ? rawVal.slice(0, commentMatch.index) : rawVal).trim();
}

/**
 * Set `varName=value` in `.env.local`. If a `varName=` line already exists
 * (e.g. the blank declaration `.env.example` ships for documentation,
 * possibly with a trailing `# comment`), that line is REPLACED in place
 * rather than appending a second `varName=` line — scripts/loadEnv.ts's
 * loader treats the first occurrence of a key as authoritative even when
 * it's blank, so a naive append would silently be shadowed by the earlier
 * empty declaration and never take effect. Returns false (no-op) if the var
 * already carries a real value.
 */
function setEnvVar(envLocalPath: string, varName: string, value: string): boolean {
  const contents = existsSync(envLocalPath) ? readFileSync(envLocalPath, 'utf-8') : '';
  if (envLineValue(contents, varName)) return false;
  const existingLine = new RegExp(`^${varName}=.*$`, 'm');
  if (existingLine.test(contents)) {
    writeFileSync(envLocalPath, contents.replace(existingLine, `${varName}=${value}`));
  } else {
    appendFileSync(envLocalPath, `\n${varName}=${value}\n`);
  }
  return true;
}

/**
 * Generate a random secret for `varName` and set it in `.env.local` if that
 * var isn't already set there (a human-typed AGON_WEB_SECRET, if present, is
 * never touched).
 */
function ensureEnvSecret(envLocalPath: string, varName: string, bytes = 32): boolean {
  return setEnvVar(envLocalPath, varName, randomBytes(bytes).toString('base64url'));
}

/** Set `varName=value` in `.env.local` only if it isn't already set. */
function ensureEnvDefault(envLocalPath: string, varName: string, value: string): boolean {
  return setEnvVar(envLocalPath, varName, value);
}

function run(command: string, args: string[]): boolean {
  // eslint-disable-next-line no-console
  console.log(`\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: ROOT });
  return result.status === 0;
}

async function waitForDbHealthy(maxAttempts = 30): Promise<boolean> {
  // Probe via `docker compose exec` + the service name (`db`), not a
  // container name — the compose file doesn't pin per-service container
  // names (see docker-compose.yml's own comment on a naming collision this
  // caused during testing), so a container-name-based check would be
  // fragile. Mirrors the healthcheck's own command.
  for (let i = 0; i < maxAttempts; i++) {
    const result = spawnSync(
      'docker',
      ['compose', '--env-file', '.env.local', 'exec', 'db', 'pg_isready', '-U', 'agon', '-d', 'agon'],
      { cwd: ROOT },
    );
    if (result.status === 0) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('Agon bootstrap — scaffolding a fresh self-hosted instance.\n');

  const steps: string[] = [];

  if (copyIfAbsent('.env.example', '.env.local') === 'created') {
    steps.push('Created .env.local from .env.example.');
  } else {
    steps.push('.env.local already exists — left untouched.');
  }

  if (copyIfAbsent('config/athlete-profile.example.json', 'config/athlete-profile.local.json') === 'created') {
    steps.push('Created config/athlete-profile.local.json from the example (placeholder values).');
  } else {
    steps.push('config/athlete-profile.local.json already exists — left untouched.');
  }

  if (copyIfAbsent('config/nutrition-goals.example.json', 'config/nutrition-goals.local.json') === 'created') {
    steps.push('Created config/nutrition-goals.local.json from the example (placeholder values).');
  } else {
    steps.push('config/nutrition-goals.local.json already exists — left untouched.');
  }

  if (copyIfAbsent('docs/training-program.example.md', 'docs/training-program.local.md') === 'created') {
    steps.push('Created docs/training-program.local.md from the example (a generic sample program).');
  } else {
    steps.push('docs/training-program.local.md already exists — left untouched.');
  }

  const envLocalPath = resolve(ROOT, '.env.local');
  if (ensureEnvDefault(envLocalPath, 'DATABASE_URL', 'postgresql://agon:agon@127.0.0.1:5432/agon')) {
    steps.push('Set DATABASE_URL to the local Docker Postgres this script is about to start.');
  }
  if (ensureEnvSecret(envLocalPath, 'AGON_WEB_SECRET')) {
    steps.push('Generated a random AGON_WEB_SECRET in .env.local — this is your login password (change it to something memorable if you prefer; it is hashed on first login, never stored in plaintext).');
  }
  if (ensureEnvSecret(envLocalPath, 'AGON_SESSION_SIGNING_KEY')) {
    steps.push('Generated a random AGON_SESSION_SIGNING_KEY in .env.local — signs session cookies, kept separate from your login password so rotating one never invalidates the other.');
  }
  if (ensureEnvSecret(envLocalPath, 'TELEGRAM_WEBHOOK_SECRET')) {
    steps.push('Generated a random TELEGRAM_WEBHOOK_SECRET in .env.local (only used if you run the webhook route instead of the long-poll listener).');
  }

  for (const s of steps) {
    // eslint-disable-next-line no-console
    console.log(`  - ${s}`);
  }

  // eslint-disable-next-line no-console
  console.log('\nStarting the database...');
  const dbUp = run('docker', ['compose', '--env-file', '.env.local', 'up', '-d', 'db']);
  if (!dbUp) {
    // eslint-disable-next-line no-console
    console.error('\ndocker compose up -d db failed — see the output above. Is Docker running?');
    process.exitCode = 1;
    return;
  }

  // eslint-disable-next-line no-console
  console.log('Waiting for Postgres to report healthy...');
  const healthy = await waitForDbHealthy();
  if (!healthy) {
    // eslint-disable-next-line no-console
    console.error('\nThe database did not become healthy in time. Check: docker compose --env-file .env.local logs db');
    process.exitCode = 1;
    return;
  }

  // eslint-disable-next-line no-console
  console.log('Applying migrations...');
  const migrated = run('tsx', ['scripts/migrate.ts']);
  if (!migrated) {
    // eslint-disable-next-line no-console
    console.error('\nMigrations failed — see the output above.');
    process.exitCode = 1;
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`
Bootstrap complete. Still manual — none of this can be scripted:

  1. Fill in your real numbers in config/athlete-profile.local.json (time
     zone, program dates, HR/sweat anchors) and your real program in
     docs/training-program.local.md + lib/training/trainingProgram.ts.
  2. Register your own OAuth apps per integration you want (Strava, Google
     Health, Google Calendar, Telegram BotFather) and fill the resulting
     client id/secret/token vars into .env.local. Every self-hoster creates
     their own — see docs/self-hosting/ for a walkthrough of each.
  3. Install and log into Tailscale on this host if you want to reach the
     app from another device — see docs/self-hosting/network-exposure.md.
  4. Choose local-AI vs. hosted LLM/transcription providers in .env.local
     (AGON_LLM_PROVIDER / AGON_TRANSCRIPTION_PROVIDER).
  5. Once your config files have real values, seed reference data:
     pnpm seed:gear && pnpm seed:fueling && pnpm seed:foods && pnpm seed:meals
     && pnpm seed:nutrition-goals && pnpm seed:planned
  6. Build and start the app: docker compose --env-file .env.local up -d --build app bot

See docs/self-hosting/README.md for the full walkthrough.
`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
