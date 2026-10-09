import { promises as fs } from 'fs';
import { dirname } from 'path';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { verifyLoginSecret as verifyLoginSecretPlaintext } from './session';

// Login-secret hashing + migration, and the session-signing-key split —
// mirrors the sibling Hephaistos project's webapp/auth/secret_store.py.
// Node-only (fs + a native argon2 binding): imported by the login route
// (Node.js API route runtime) only, NEVER by middleware.ts, which runs on
// the Edge runtime and only needs lib/auth/session.ts's Web-Crypto HMAC
// verify — that split is why this file and session.ts stay separate.
//
// Two secrets, kept apart on purpose:
// - The LOGIN secret (AGON_WEB_SECRET) — what you type to log in. Never
//   compared raw: LoginSecretGate verifies against an Argon2id hash. A
//   fresh `.env.local` (or one from before this change) has only the
//   plaintext env var; the gate falls back to it once and MIGRATES on the
//   first successful login — hashing the secret and persisting it via
//   `persistHash`, after which the hash is authoritative and the plaintext
//   is never consulted again. No self-hoster action either way.
// - The session SIGNING key (AGON_SESSION_SIGNING_KEY) — signs session
//   cookies (lib/auth/session.ts). Deliberately a plain env var, generated
//   once by scripts/bootstrap.ts like AGON_WEB_SECRET/TELEGRAM_WEBHOOK_SECRET
//   — NOT a persisted file the way Hephaistos does it, because Next.js
//   Middleware runs on the Edge runtime even in a self-hosted deploy
//   (session.ts's own comment) and Edge code can't read a file this module
//   writes. An env var is the one representation both runtimes can share.
//   Rotating it (re-running bootstrap, or editing .env.local by hand) just
//   invalidates existing sessions — it never touches the login password.
//
// Where the migrated login-secret hash is written: a file under `data/`
// (gitignored, bind-mounted read-write in docker-compose.yml — see
// DEFAULT_HASH_PATH), NOT back into .env.local. A running container has no
// access to the host's .env.local to rewrite it (docker-compose.yml injects
// it via `env_file:`, which does not bind-mount the file itself) — same
// constraint Hephaistos's own secret_store.py documents for its Railway
// deploy target. `data/` already exists for exactly this: a writable,
// restart-durable directory the app itself owns.

export const LOGIN_SECRET_ENV = 'AGON_WEB_SECRET';
// Optional: an operator may supply an already-hashed secret directly
// (env-only deploys, or to pre-provision a hash without the plaintext ever
// touching the running process). Most deployments never set this — it is
// populated by the migration below instead, into the persisted hash file.
export const LOGIN_SECRET_HASH_ENV = 'AGON_WEB_SECRET_HASH';

export const DEFAULT_HASH_PATH = 'data/auth/web-secret.hash';

export class MissingLoginSecretError extends Error {}

/** Argon2id-hash a login secret for storage. Salted — never compare hashes
 * for equality; always route through LoginSecretGate/argon2's own verify.
 * No explicit `algorithm` option: Argon2id is @node-rs/argon2's own default
 * (referencing its `Algorithm` const enum breaks under isolatedModules, which
 * both ts-jest and Next's SWC transform use). */
export async function hashLoginSecret(secret: string): Promise<string> {
  return argon2Hash(secret);
}

async function verifyLoginSecretHash(hash: string, provided: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, provided);
  } catch {
    // Malformed/foreign hash string — never let argon2's own parse error
    // surface as a 500; a bad stored hash just means "doesn't match".
    return false;
  }
}

/** Return the previously-persisted login secret hash, or null if absent. */
export async function loadPersistedLoginSecretHash(path: string): Promise<string | null> {
  try {
    const value = (await fs.readFile(path, 'utf-8')).trim();
    return value || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Write the migrated login secret hash to `path`, 0600 (owner-only): it
 * gates authentication, so it is treated like a credential. */
export async function persistLoginSecretHash(path: string, hashValue: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, hashValue, { mode: 0o600 });
  await fs.chmod(path, 0o600);
}

export interface LoginSecretGateOptions {
  plaintext?: string;
  storedHash?: string | null;
  persistHash: (hash: string) => Promise<void>;
}

/** Verifies a submitted login secret against the configured hash, migrating
 * a legacy plaintext-only config to a hash on the first successful login. */
export class LoginSecretGate {
  private storedHash: string | null;
  private readonly plaintext?: string;
  private readonly persistHash: (hash: string) => Promise<void>;

  constructor(opts: LoginSecretGateOptions) {
    if (!opts.plaintext && !opts.storedHash) {
      throw new MissingLoginSecretError(
        `neither ${LOGIN_SECRET_ENV} nor ${LOGIN_SECRET_HASH_ENV} is set; configure one before ` +
          'starting the web app (it is the password you log in with)',
      );
    }
    this.plaintext = opts.plaintext;
    this.storedHash = opts.storedHash ?? null;
    this.persistHash = opts.persistHash;
  }

  /** A gate over a bare plaintext secret with no persistence — for tests. */
  static forPlaintext(secret: string): LoginSecretGate {
    return new LoginSecretGate({ plaintext: secret, storedHash: null, persistHash: async () => {} });
  }

  /**
   * True iff `provided` matches. Checks the hash when one is known — that
   * path is authoritative and the legacy plaintext is never consulted once a
   * hash exists. Otherwise falls back to a constant-time-ish plaintext
   * compare and, on success, hashes + persists it so every later call takes
   * the hash path. Empty input never authenticates.
   */
  async verify(provided: string): Promise<boolean> {
    if (!provided) return false;
    if (this.storedHash !== null) {
      return verifyLoginSecretHash(this.storedHash, provided);
    }
    if (this.plaintext && (await verifyLoginSecretPlaintext(provided, this.plaintext))) {
      const newHash = await hashLoginSecret(provided);
      await this.persistHash(newHash);
      this.storedHash = newHash;
      return true;
    }
    return false;
  }
}

/**
 * Compose the LoginSecretGate from the environment + the persisted hash
 * file. Hash precedence: an explicit AGON_WEB_SECRET_HASH env var, then the
 * file a prior migration persisted, then none (plaintext-only — migrated on
 * the first login). Throws MissingLoginSecretError (crash-early, before the
 * server binds) if neither a plaintext secret nor a hash is configured.
 */
export async function buildLoginSecretGate(
  env: Record<string, string | undefined> = process.env,
  hashPath: string = DEFAULT_HASH_PATH,
): Promise<LoginSecretGate> {
  const plaintext = (env[LOGIN_SECRET_ENV] ?? '').trim() || undefined;
  let storedHash = (env[LOGIN_SECRET_HASH_ENV] ?? '').trim() || undefined;
  if (!storedHash) {
    storedHash = (await loadPersistedLoginSecretHash(hashPath)) ?? undefined;
  }
  return new LoginSecretGate({
    plaintext,
    storedHash: storedHash ?? null,
    persistHash: (h) => persistLoginSecretHash(hashPath, h),
  });
}
