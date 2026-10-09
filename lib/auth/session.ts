// Framework-free auth core: mint/verify a signed, TTL-bounded session cookie
// and compare the shared login secret in constant time. No Next.js imports
// here — middleware.ts and the login route are thin wrappers over this, so
// the security-critical logic is testable without a server (mirrors the
// sibling Hephaistos project's webapp/auth/session.py).
//
// Uses the Web Crypto API (globalThis.crypto.subtle), NOT Node's `crypto`
// module — this file runs in Next.js Middleware, which by default executes
// on the Edge runtime (no Node built-ins) even in a self-hosted, non-Vercel
// deployment. Web Crypto is available in both the Edge runtime and Node 19+,
// so one implementation works everywhere without a runtime-specific branch.

const SALT = 'agon-web-session-v1';

export interface SessionPayload {
  /** Single-owner app — always "owner", kept as a field for shape parity with
   * a future multi-user principal and so a forged payload missing it is
   * rejected by the shape check below. */
  subject: string;
  /** Epoch seconds the session was minted. */
  iat: number;
  /** Per-session CSRF secret, rendered into mutation requests. */
  csrf: string;
}

export interface VerifiedSession {
  payload: SessionPayload;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const withPad = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(withPad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${SALT}:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Mint a signed session cookie value for the single owner, with a fresh CSRF secret. */
export async function mintSessionCookie(
  secret: string,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const csrfBytes = new Uint8Array(24);
  crypto.getRandomValues(csrfBytes);
  const payload: SessionPayload = {
    subject: 'owner',
    iat: nowEpoch,
    csrf: base64url(csrfBytes),
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, payloadBytes);
  return `${base64url(payloadBytes)}.${base64url(new Uint8Array(signature))}`;
}

/** Verify a session cookie: valid signature AND unexpired, else null (never throws). */
export async function verifySessionCookie(
  cookie: string,
  secret: string,
  ttlSeconds: number,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): Promise<VerifiedSession | null> {
  const dot = cookie.indexOf('.');
  if (dot === -1) return null;
  const payloadPart = cookie.slice(0, dot);
  const sigPart = cookie.slice(dot + 1);

  let payloadBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    payloadBytes = base64urlToBytes(payloadPart);
    sigBytes = base64urlToBytes(sigPart);
  } catch {
    return null;
  }

  const key = await hmacKey(secret);
  const validSignature = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes as BufferSource,
    payloadBytes as BufferSource,
  );
  if (!validSignature) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as SessionPayload).subject !== 'string' ||
    typeof (payload as SessionPayload).iat !== 'number' ||
    typeof (payload as SessionPayload).csrf !== 'string'
  ) {
    return null;
  }
  const typed = payload as SessionPayload;
  if (nowEpoch - typed.iat > ttlSeconds) return null;

  return { payload: typed };
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

/**
 * Constant-time-ish compare of the submitted login secret against the
 * configured one. Both sides are hashed to a fixed-length digest first so the
 * comparison never leaks the raw input length, then compared byte-by-byte
 * without short-circuiting. Empty inputs never authenticate.
 */
export async function verifyLoginSecret(provided: string, expected: string): Promise<boolean> {
  if (!provided || !expected) return false;
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Constant-time-ish CSRF token compare (same digest trick as verifyLoginSecret). */
export async function verifyCsrf(session: VerifiedSession, submitted: string | null): Promise<boolean> {
  if (!submitted) return false;
  return verifyLoginSecret(submitted, session.payload.csrf);
}
