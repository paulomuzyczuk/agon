import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from './loadEnv';
import { loadWebBindConfig, assertSafeBind, BindSafetyError } from '../lib/webBind';
import { DEFAULT_HASH_PATH } from '../lib/auth/secretStore';
import { logger } from '../services/logger';

// Composition root for the production web server: validates the bind target
// BEFORE the server ever opens a socket, then execs it with PORT/HOSTNAME
// pinned to that target. This is the one place lib/webBind.ts's guard
// actually runs (mirrors Hephaistos's webapp/config.py + its uvicorn.run()
// call site).
//
// Runs `server.js` (next.config.mjs's `output: 'standalone'` build entry,
// copied to the repo root by the `postbuild` script) rather than `next
// start` — Next.js explicitly warns "next start does not work with output:
// standalone" and recommends `node .next/standalone/server.js` instead. That
// script reads PORT/HOSTNAME env vars (defaulting hostname to the public
// 0.0.0.0 wildcard!), which is exactly why assertSafeBind must run first.
//
//   pnpm start   → runs this (see package.json; requires `pnpm build` first)

loadEnv();

if (
  !(process.env.AGON_WEB_SECRET ?? '').trim() &&
  !(process.env.AGON_WEB_SECRET_HASH ?? '').trim() &&
  !existsSync(resolve(process.cwd(), DEFAULT_HASH_PATH))
) {
  // Crash-early (Hephaistos's read_login_secret does the same): a web layer
  // with no login secret must not start, not silently serve every route
  // unauthenticated.
  // eslint-disable-next-line no-console
  console.error(
    '\nAGON_WEB_SECRET is missing or empty. Set it in .env.local before starting the ' +
      'web server (it is the password you log in with) — generate one with:\n' +
      '  openssl rand -base64 32\n',
  );
  process.exit(1);
}

if (!(process.env.AGON_SESSION_SIGNING_KEY ?? '').trim()) {
  // Separate from AGON_WEB_SECRET on purpose — see lib/auth/secretStore.ts.
  // eslint-disable-next-line no-console
  console.error(
    '\nAGON_SESSION_SIGNING_KEY is missing or empty. Set it in .env.local before starting ' +
      'the web server (it signs session cookies, independently of your login password) — ' +
      'generate one with:\n' +
      '  openssl rand -base64 32\n',
  );
  process.exit(1);
}

let config;
try {
  config = loadWebBindConfig();
} catch (err) {
  logger.error('start-web: invalid bind configuration', {}, err as Error);
  process.exit(1);
}

try {
  assertSafeBind(config);
} catch (err) {
  if (err instanceof BindSafetyError) {
    // eslint-disable-next-line no-console
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const serverPath = resolve(process.cwd(), 'server.js');
if (!existsSync(serverPath)) {
  // eslint-disable-next-line no-console
  console.error(
    `\nstart-web: ${serverPath} not found. Run \`pnpm build\` first — the ` +
      '`postbuild` step copies it from .next/standalone/server.js.\n',
  );
  process.exit(1);
}

logger.info('start-web: starting server.js', {
  bindHost: config.bindHost,
  bindPort: config.bindPort,
});

const child = spawn('node', [serverPath], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(config.bindPort),
    HOSTNAME: config.bindHost,
  },
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
