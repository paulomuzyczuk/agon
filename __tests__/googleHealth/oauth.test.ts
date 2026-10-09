// DB is mocked — this suite exercises the OAuth refresh decision and token
// lifecycle without a live Postgres. The query mock routes by statement verb.
jest.mock('@/services/db', () => ({ query: jest.fn() }));

import { query } from '@/services/db';
import {
  accessTokenIsFresh,
  getValidAccessToken,
  exchangeAuthorizationCode,
} from '@/services/googleHealth/oauth';

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

const OLD_ENV = process.env;
beforeEach(() => {
  process.env = {
    ...OLD_ENV,
    GOOGLE_HEALTH_CLIENT_ID: 'cid',
    GOOGLE_HEALTH_CLIENT_SECRET: 'secret',
    GOOGLE_HEALTH_REDIRECT_URI: 'http://localhost:3000/google-health/callback',
  };
});

afterEach(() => {
  process.env = OLD_ENV;
  queryMock.mockReset();
  jest.restoreAllMocks();
});

describe('accessTokenIsFresh', () => {
  it('is fresh when expiry is beyond now + skew', () => {
    expect(accessTokenIsFresh(1000, 800, 120)).toBe(true); // 880 > 800
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
        access_token: 'stored-access',
        refresh_token: 'stored-refresh',
        expires_at: future,
        scope: 'health.activity_and_fitness',
      },
    ]);
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    await expect(getValidAccessToken()).resolves.toBe('stored-access');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes and persists when stale, keeping the stored refresh token when the response omits it', async () => {
    const past = new Date(Date.now() - 60 * 1000);
    routeQuery([
      {
        access_token: 'old-access',
        refresh_token: 'durable-refresh',
        expires_at: past,
        scope: 'health.activity_and_fitness',
      },
    ]);
    // Google refresh responses omit refresh_token.
    tokenFetch({
      token_type: 'Bearer',
      access_token: 'new-access',
      expires_in: 3599,
    });

    await expect(getValidAccessToken()).resolves.toBe('new-access');
    const writeCall = queryMock.mock.calls.find(
      (c) => !/^\s*SELECT/i.test(c[0] as string),
    );
    expect(writeCall).toBeDefined();
    // the durable refresh token is re-persisted (params: access, refresh, ...)
    expect(writeCall![1]).toContain('durable-refresh');
  });

  it('throws when no tokens have been authorized', async () => {
    routeQuery([]);
    await expect(getValidAccessToken()).rejects.toThrow(/gh:auth/);
  });
});

describe('exchangeAuthorizationCode', () => {
  it('rejects a code exchange that returns no refresh token', async () => {
    routeQuery([]);
    tokenFetch({
      token_type: 'Bearer',
      access_token: 'a',
      expires_in: 3599,
      // no refresh_token — offline access wasn't requested
    });
    await expect(exchangeAuthorizationCode('code123')).rejects.toThrow(
      /no refresh_token/,
    );
  });

  it('persists the tokens on a well-formed offline consent', async () => {
    routeQuery([]);
    tokenFetch({
      token_type: 'Bearer',
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 3599,
      scope: 'health.activity_and_fitness',
    });
    await expect(
      exchangeAuthorizationCode('code123', 1000),
    ).resolves.toMatchObject({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 1000 + 3599,
    });
  });
});
