// Shared constants between middleware.ts, the login/logout routes, and the
// login page — one place so the cookie/header names can't drift apart.

export const SESSION_COOKIE = 'agon_session';
export const CSRF_HEADER = 'x-csrf-token';

/** Routes reachable without a valid session (self-hosting login gate). */
export function isPublicPath(pathname: string): boolean {
  if (pathname === '/login') return true;
  if (pathname.startsWith('/api/auth/')) return true;
  // Liveness/DB-reachability probe pinged by external uptime monitoring
  // (n8n, etc.) — see CLAUDE.md: named general-health, not health, because
  // this path was already the probe.
  if (pathname === '/api/health') return true;
  // Telegram calls this directly with its own secret-token header
  // (X-Telegram-Bot-Api-Secret-Token, checked in the route itself) — it will
  // never carry our session cookie.
  if (pathname === '/api/telegram/webhook') return true;
  // Next.js internals + the PWA manifest/icons must always be servable.
  if (pathname.startsWith('/_next/')) return true;
  if (pathname === '/manifest.webmanifest' || pathname === '/favicon.ico')
    return true;
  // The PWA icons named in the manifest: the browser fetches them without our
  // session cookie, and Chrome withholds "Install app" if they redirect to /login.
  if (pathname.startsWith('/icons/')) return true;
  // The service worker script (MZY-207): it holds no data, and it must stay
  // fetchable after a session expires so the offline shell keeps updating.
  if (pathname === '/sw.js') return true;
  return false;
}
