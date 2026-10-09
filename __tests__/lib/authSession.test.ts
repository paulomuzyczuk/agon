import {
  mintSessionCookie,
  verifySessionCookie,
  verifyLoginSecret,
  verifyCsrf,
} from '@/lib/auth/session';

// Framework-free auth core (self-hosting login gate) — mirrors the sibling
// Hephaistos project's webapp/auth/session.py test coverage.

describe('mintSessionCookie / verifySessionCookie', () => {
  const secret = 'correct horse battery staple';

  it('mints a cookie that verifies against the same secret', async () => {
    const cookie = await mintSessionCookie(secret, 1_000_000);
    const session = await verifySessionCookie(cookie, secret, 3600, 1_000_100);
    expect(session).not.toBeNull();
    expect(session!.payload.subject).toBe('owner');
    expect(session!.payload.iat).toBe(1_000_000);
    expect(session!.payload.csrf).toEqual(expect.any(String));
  });

  it('rejects a cookie signed with a different secret', async () => {
    const cookie = await mintSessionCookie(secret, 1_000_000);
    const session = await verifySessionCookie(cookie, 'wrong secret', 3600, 1_000_100);
    expect(session).toBeNull();
  });

  it('rejects an expired cookie', async () => {
    const cookie = await mintSessionCookie(secret, 1_000_000);
    // exactly at the TTL boundary is still expired (now - iat > ttl check)
    const session = await verifySessionCookie(cookie, secret, 3600, 1_000_000 + 3601);
    expect(session).toBeNull();
  });

  it('accepts a cookie right up to the TTL boundary', async () => {
    const cookie = await mintSessionCookie(secret, 1_000_000);
    const session = await verifySessionCookie(cookie, secret, 3600, 1_000_000 + 3600);
    expect(session).not.toBeNull();
  });

  it('rejects garbage input without throwing', async () => {
    await expect(verifySessionCookie('not-a-real-cookie', secret, 3600)).resolves.toBeNull();
    await expect(verifySessionCookie('', secret, 3600)).resolves.toBeNull();
    await expect(verifySessionCookie('a.b.c', secret, 3600)).resolves.toBeNull();
  });

  it('mints a fresh, distinct CSRF secret each time', async () => {
    const a = await mintSessionCookie(secret, 1_000_000);
    const b = await mintSessionCookie(secret, 1_000_000);
    const sa = await verifySessionCookie(a, secret, 3600, 1_000_000);
    const sb = await verifySessionCookie(b, secret, 3600, 1_000_000);
    expect(sa!.payload.csrf).not.toEqual(sb!.payload.csrf);
  });
});

describe('verifyLoginSecret', () => {
  it('accepts a matching secret', async () => {
    await expect(verifyLoginSecret('abc123', 'abc123')).resolves.toBe(true);
  });

  it('rejects a mismatched secret', async () => {
    await expect(verifyLoginSecret('abc123', 'abc124')).resolves.toBe(false);
  });

  it('rejects empty provided or expected values', async () => {
    await expect(verifyLoginSecret('', 'abc123')).resolves.toBe(false);
    await expect(verifyLoginSecret('abc123', '')).resolves.toBe(false);
    await expect(verifyLoginSecret('', '')).resolves.toBe(false);
  });
});

describe('verifyCsrf', () => {
  it('accepts the session csrf secret echoed back', async () => {
    const cookie = await mintSessionCookie('s3cr3t', 1_000_000);
    const session = await verifySessionCookie(cookie, 's3cr3t', 3600, 1_000_000);
    await expect(verifyCsrf(session!, session!.payload.csrf)).resolves.toBe(true);
  });

  it('rejects a missing or wrong token', async () => {
    const cookie = await mintSessionCookie('s3cr3t', 1_000_000);
    const session = await verifySessionCookie(cookie, 's3cr3t', 3600, 1_000_000);
    await expect(verifyCsrf(session!, null)).resolves.toBe(false);
    await expect(verifyCsrf(session!, 'wrong-token')).resolves.toBe(false);
  });
});
