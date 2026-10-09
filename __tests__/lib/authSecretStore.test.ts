import { mkdtempSync, rmSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LoginSecretGate,
  MissingLoginSecretError,
  buildLoginSecretGate,
  hashLoginSecret,
  loadPersistedLoginSecretHash,
  persistLoginSecretHash,
} from '@/lib/auth/secretStore';

// Login-secret Argon2id hashing + first-login migration (self-hosting login
// gate) — mirrors the sibling Hephaistos project's
// tests/test_webapp_auth_secret_store.py coverage.

describe('hashLoginSecret / loadPersistedLoginSecretHash / persistLoginSecretHash', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agon-secret-store-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for a hash file that does not exist yet', async () => {
    await expect(loadPersistedLoginSecretHash(join(dir, 'nope.hash'))).resolves.toBeNull();
  });

  it('persists a hash file 0600 and reads it back', async () => {
    const hash = await hashLoginSecret('correct horse battery staple');
    const path = join(dir, 'nested', 'web-secret.hash');
    await persistLoginSecretHash(path, hash);

    expect(readFileSync(path, 'utf-8')).toBe(hash);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await expect(loadPersistedLoginSecretHash(path)).resolves.toBe(hash);
  });

  it('produces a hash that verifies only against the original secret', async () => {
    const hash = await hashLoginSecret('s3cr3t');
    const gate = new LoginSecretGate({ storedHash: hash, persistHash: async () => {} });
    await expect(gate.verify('s3cr3t')).resolves.toBe(true);
    await expect(gate.verify('wrong')).resolves.toBe(false);
  });
});

describe('LoginSecretGate', () => {
  it('throws MissingLoginSecretError when neither plaintext nor hash is configured', () => {
    expect(() => new LoginSecretGate({ persistHash: async () => {} })).toThrow(
      MissingLoginSecretError,
    );
  });

  it('rejects empty input without consulting either path', async () => {
    const gate = LoginSecretGate.forPlaintext('s3cr3t');
    await expect(gate.verify('')).resolves.toBe(false);
  });

  it('verifies against a pre-provisioned hash and never touches plaintext', async () => {
    const hash = await hashLoginSecret('the-real-secret');
    let persisted = false;
    const gate = new LoginSecretGate({
      storedHash: hash,
      persistHash: async () => {
        persisted = true;
      },
    });
    await expect(gate.verify('the-real-secret')).resolves.toBe(true);
    await expect(gate.verify('wrong')).resolves.toBe(false);
    expect(persisted).toBe(false);
  });

  it('migrates a legacy plaintext secret to a hash on first successful login', async () => {
    let persistedHash: string | null = null;
    const gate = new LoginSecretGate({
      plaintext: 'legacy-secret',
      persistHash: async (h) => {
        persistedHash = h;
      },
    });

    await expect(gate.verify('wrong')).resolves.toBe(false);
    expect(persistedHash).toBeNull();

    await expect(gate.verify('legacy-secret')).resolves.toBe(true);
    expect(persistedHash).not.toBeNull();

    // After migration, the hash path is authoritative — the gate still
    // accepts the same secret (now via the hash it just persisted).
    await expect(gate.verify('legacy-secret')).resolves.toBe(true);
  });
});

describe('buildLoginSecretGate', () => {
  let dir: string;
  let hashPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agon-secret-store-'));
    hashPath = join(dir, 'web-secret.hash');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws MissingLoginSecretError when nothing is configured', async () => {
    await expect(buildLoginSecretGate({}, hashPath)).rejects.toThrow(MissingLoginSecretError);
  });

  it('prefers an explicit AGON_WEB_SECRET_HASH env var over a persisted file', async () => {
    const hash = await hashLoginSecret('env-hash-secret');
    const gate = await buildLoginSecretGate({ AGON_WEB_SECRET_HASH: hash }, hashPath);
    await expect(gate.verify('env-hash-secret')).resolves.toBe(true);
  });

  it('falls back to a previously persisted hash file', async () => {
    const hash = await hashLoginSecret('file-hash-secret');
    await persistLoginSecretHash(hashPath, hash);
    const gate = await buildLoginSecretGate({}, hashPath);
    await expect(gate.verify('file-hash-secret')).resolves.toBe(true);
  });

  it('migrates a plaintext AGON_WEB_SECRET and persists the hash to disk', async () => {
    const gate = await buildLoginSecretGate({ AGON_WEB_SECRET: 'plaintext-secret' }, hashPath);
    await expect(gate.verify('plaintext-secret')).resolves.toBe(true);
    await expect(loadPersistedLoginSecretHash(hashPath)).resolves.not.toBeNull();

    // A freshly built gate now takes the hash path with no plaintext at all.
    const rebuilt = await buildLoginSecretGate({}, hashPath);
    await expect(rebuilt.verify('plaintext-secret')).resolves.toBe(true);
  });
});
