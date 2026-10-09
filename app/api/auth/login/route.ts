import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { mintSessionCookie } from '@/lib/auth/session';
import { buildLoginSecretGate, MissingLoginSecretError } from '@/lib/auth/secretStore';
import { loginRateLimiter, clientKey } from '@/lib/auth/rateLimit';
import { SESSION_COOKIE } from '@/lib/auth/cookie';
import { loadWebBindConfig } from '@/lib/webBind';
import { logger } from '@/services/logger';

// POST /api/auth/login — the single-owner login gate (self-hosting decision,
// CLAUDE.md "Network exposure"). Verifies the submitted secret via
// LoginSecretGate (Argon2id hash, migrating a legacy plaintext AGON_WEB_SECRET
// on first success — lib/auth/secretStore.ts) and, on success, sets a signed
// HttpOnly session cookie signed with the separate AGON_SESSION_SIGNING_KEY.
// Rate-limited per client IP (5 failures / 5 min -> 15 min lockout) since this
// one shared secret guards the whole app. Node.js runtime (the default for
// API routes) — required for the Argon2 native binding + fs-backed hash file.
export const dynamic = 'force-dynamic';

const LoginBody = z.object({ secret: z.string().min(1) });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const signingKey = (process.env.AGON_SESSION_SIGNING_KEY ?? '').trim();
  if (!signingKey) {
    logger.error('login: AGON_SESSION_SIGNING_KEY is not set', {});
    return NextResponse.json(
      { error: 'server misconfigured: AGON_SESSION_SIGNING_KEY is not set' },
      { status: 500 },
    );
  }

  let gate;
  try {
    gate = await buildLoginSecretGate();
  } catch (err) {
    if (err instanceof MissingLoginSecretError) {
      logger.error('login: no login secret configured', {});
      return NextResponse.json(
        { error: 'server misconfigured: AGON_WEB_SECRET is not set' },
        { status: 500 },
      );
    }
    throw err;
  }

  const key = clientKey(request.headers.get('x-forwarded-for'));
  if (!loginRateLimiter.isAllowed(key)) {
    const retryAfter = loginRateLimiter.retryAfterSeconds(key);
    return NextResponse.json(
      { error: 'too many failed attempts, try again later' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
  }

  const parsed = LoginBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  const valid = await gate.verify(parsed.data.secret);
  if (!valid) {
    loginRateLimiter.recordFailure(key);
    return NextResponse.json({ error: 'incorrect secret' }, { status: 401 });
  }
  loginRateLimiter.recordSuccess(key);

  const { sessionTtlSeconds } = loadWebBindConfig();
  const cookieValue = await mintSessionCookie(signingKey);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, cookieValue, {
    httpOnly: true,
    sameSite: 'lax',
    // Tailscale is plain HTTP by default — forcing Secure would silently drop
    // the cookie. Only require it when the request actually arrived over TLS
    // (a self-hoster running their own reverse proxy + AGON_WEB_ALLOW_PUBLIC).
    secure: request.nextUrl.protocol === 'https:',
    path: '/',
    maxAge: sessionTtlSeconds,
  });
  return response;
}
