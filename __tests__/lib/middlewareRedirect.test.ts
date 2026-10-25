/** @jest-environment node */
import { NextRequest } from 'next/server';
import { middleware, redirectToLogin } from '../../middleware';

// Regression: behind `tailscale serve` the standalone server's request.url
// carries the bind address (localhost:3100), so the login redirect sent the
// phone to an unreachable host. The redirect must follow the host the client
// used, and stay absolute (Next middleware throws ERR_INVALID_URL on a
// relative Location).
const TAILNET_HOST = 'tower.example.ts.net';

function request(path: string, headers: Record<string, string>): NextRequest {
  return new NextRequest(`http://localhost:3100${path}`, { headers });
}

describe('login redirect', () => {
  it('follows the forwarded host and protocol, not the bind address', () => {
    const res = redirectToLogin(
      request('/record', { host: TAILNET_HOST, 'x-forwarded-proto': 'https' }),
      '/record',
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      `https://${TAILNET_HOST}/login?next=%2Frecord`,
    );
  });

  it('prefers x-forwarded-host and uses the first value of a proxy chain', () => {
    const res = redirectToLogin(
      request('/record', {
        host: '127.0.0.1:3100',
        'x-forwarded-host': `${TAILNET_HOST}, other.example`,
        'x-forwarded-proto': 'https, http',
      }),
      '/record',
    );
    expect(res.headers.get('location')).toBe(
      `https://${TAILNET_HOST}/login?next=%2Frecord`,
    );
  });

  it('encodes the path so it cannot inject query parameters', () => {
    const res = redirectToLogin(
      request('/x', { host: TAILNET_HOST }),
      '/a?b=1&c=2',
    );
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.searchParams.get('next')).toBe('/a?b=1&c=2');
    expect([...location.searchParams.keys()]).toEqual(['next']);
  });

  it('ignores an unknown forwarded protocol', () => {
    const res = redirectToLogin(
      request('/record', {
        host: TAILNET_HOST,
        'x-forwarded-proto': 'javascript',
      }),
      '/record',
    );
    expect(res.headers.get('location')).toMatch(/^http:\/\//);
  });

  it('middleware redirects an unauthenticated page request to the client host', async () => {
    const saved = process.env.AGON_SESSION_SIGNING_KEY;
    process.env.AGON_SESSION_SIGNING_KEY = 'test-signing-key-not-a-real-secret';
    try {
      const res = await middleware(
        request('/record', {
          host: TAILNET_HOST,
          'x-forwarded-proto': 'https',
        }),
      );
      expect(res.headers.get('location')).toBe(
        `https://${TAILNET_HOST}/login?next=%2Frecord`,
      );
    } finally {
      if (saved === undefined) delete process.env.AGON_SESSION_SIGNING_KEY;
      else process.env.AGON_SESSION_SIGNING_KEY = saved;
    }
  });

  it('still answers API routes with 401, not a redirect', async () => {
    const saved = process.env.AGON_SESSION_SIGNING_KEY;
    process.env.AGON_SESSION_SIGNING_KEY = 'test-signing-key-not-a-real-secret';
    try {
      const res = await middleware(
        request('/api/rides', { host: TAILNET_HOST }),
      );
      expect(res.status).toBe(401);
    } finally {
      if (saved === undefined) delete process.env.AGON_SESSION_SIGNING_KEY;
      else process.env.AGON_SESSION_SIGNING_KEY = saved;
    }
  });
});
