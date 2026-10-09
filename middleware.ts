import { NextRequest, NextResponse } from 'next/server';
import { verifySessionCookie } from '@/lib/auth/session';
import { SESSION_COOKIE, isPublicPath } from '@/lib/auth/cookie';
import { loadWebBindConfig } from '@/lib/webBind';

// Single-owner login gate (self-hosting decision, CLAUDE.md "Network
// exposure"). Reachability via Tailscale is NOT authentication — this is the
// one choke point every request passes through before reaching a page or API
// route, mirroring the sibling Hephaistos project's require_session
// dependency. AGON_SESSION_SIGNING_KEY presence itself is enforced at process
// startup (scripts/start-web.ts), not here — a missing secret is a
// startup-time misconfiguration, not a per-request condition. This key is
// deliberately separate from AGON_WEB_SECRET (the login password, verified
// via an Argon2id hash in lib/auth/secretStore.ts) — it only signs the
// session cookie, so rotating the login password never invalidates every
// other session and vice versa.
//
// CSRF: the session cookie is HttpOnly + SameSite=Lax, which already blocks
// the cookie from riding along on a cross-site POST (the practical CSRF
// vector) in every modern browser. The session payload also carries a
// per-session CSRF secret (lib/auth/session.ts) for a stricter
// token-verification pass later, but that isn't wired into every existing
// mutating API route yet — deliberately deferred rather than silently
// half-built; see CLAUDE.md's self-hosting network-exposure entry.

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const signingKey = (process.env.AGON_SESSION_SIGNING_KEY ?? '').trim();
  if (!signingKey) {
    // Belt-and-suspenders: start-web.ts already refuses to boot without this,
    // but `next dev`/other entrypoints don't go through that wrapper.
    return unauthorized(request, pathname);
  }

  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  const { sessionTtlSeconds } = loadWebBindConfig();
  const session = cookie ? await verifySessionCookie(cookie, signingKey, sessionTtlSeconds) : null;

  if (!session) return unauthorized(request, pathname);
  return NextResponse.next();
}

function unauthorized(request: NextRequest, pathname: string): NextResponse {
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'authentication required' }, { status: 401 });
  }
  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('next', pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Every request except Next's own static asset pipeline (still filtered
  // again by isPublicPath for the rest — this matcher is just a fast skip).
  matcher: ['/((?!_next/static|_next/image).*)'],
};
