// DB is mocked — this suite exercises the OAuth refresh decision and token
// lifecycle without a live Postgres. The query mock routes by statement verb.
jest.mock('@/services/db', () => ({ query: jest.fn() }));

import { query } from '@/services/db';
import {
  accessTokenIsFresh,
  getValidAccessToken,
  exchangeAuthorizationCode,
} from '@/services/strava/oauth';

const queryMock = query as unknown as jest.Mock;

function routeQuery(selectRows: unknown[]): void {
  queryMock.mockImplementation((sql: string) => {
    if (/^\s*SELECT/i.test(sql)) return Promise.resolve({ rows: selectRows });
    return Promise.resolve({ rows: [] }); // INSERT/UPSERT
  });
}

function tokenFetch(body: Record<string, unknown>): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response) as unknown as typeof fetch;
}

afterEach(() => {
  queryMock.mockReset();
  jest.restoreAllMocks();
});

describe('accessTokenIsFresh', () => {
  it('is fresh when expiry is beyond now + skew', () => {
    expect(accessTokenIsFresh(1000, 800, 120)).toBe(true); // 1000-120=880 > 800
  });
  it('is stale inside the skew window', () => {
    expect(accessTokenIsFresh(1000, 900, 120)).toBe(false); // 880 <= 900
  });
});

describe('getValidAccessToken', () => {
  it('returns the stored token without refreshing when fresh', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    routeQuery([
      {
        athlete_id: '42',
        access_token: 'stored-access',
        refresh_token: 'stored-refresh',
        expires_at: future,
        scope: 'read,activity:read_all',
      },
    ]);
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    await expect(getValidAccessToken()).resolves.toBe('stored-access');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes and persists when the stored token is stale', async () => {
    const past = new Date(Date.now() - 60 * 1000);
    routeQuery([
      {
        athlete_id: '42',
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        expires_at: past,
        scope: 'read',
      },
    ]);
    tokenFetch({
      token_type: 'Bearer',
      access_token: 'new-access',
      refresh_token: 'rotated-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 21600,
      expires_in: 21600,
    });

    await expect(getValidAccessToken()).resolves.toBe('new-access');
    // one SELECT (read) + one INSERT (persist rotated token)
    const verbs = queryMock.mock.calls.map((c) =>
      /^\s*SELECT/i.test(c[0] as string) ? 'select' : 'write',
    );
    expect(verbs).toContain('write');
  });

  it('throws when no tokens have been authorized', async () => {
    routeQuery([]);
    await expect(getValidAccessToken()).rejects.toThrow(/strava:auth/);
  });
});

describe('exchangeAuthorizationCode', () => {
  it('rejects a token response missing the athlete id', async () => {
    routeQuery([]);
    tokenFetch({
      token_type: 'Bearer',
      access_token: 'a',
      refresh_token: 'r',
      expires_at: 123,
      expires_in: 456,
      // no `athlete`
    });
    await expect(exchangeAuthorizationCode('code123')).rejects.toThrow(
      /missing athlete/,
    );
  });
});
