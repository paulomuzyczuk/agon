jest.mock('@/services/db', () => ({ query: jest.fn() }));

import { query } from '@/services/db';
import {
  accessTokenIsFresh,
  getValidAccessToken,
  exchangeAuthorizationCode,
} from '@/services/fitbit/oauth';

const queryMock = query as unknown as jest.Mock;

function routeQuery(selectRows: unknown[]): void {
  queryMock.mockImplementation((sql: string) => {
    if (/^\s*SELECT/i.test(sql)) return Promise.resolve({ rows: selectRows });
    return Promise.resolve({ rows: [] });
  });
}

function tokenFetch(body: Record<string, unknown>): jest.Mock {
  const fn = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

afterEach(() => {
  queryMock.mockReset();
  jest.restoreAllMocks();
});

describe('accessTokenIsFresh', () => {
  it('is fresh well before expiry and stale inside the skew', () => {
    expect(accessTokenIsFresh(1000, 800, 120)).toBe(true);
    expect(accessTokenIsFresh(1000, 900, 120)).toBe(false);
  });
});

describe('getValidAccessToken', () => {
  it('returns the stored token without refreshing when fresh', async () => {
    const future = new Date(Date.now() + 3600_000);
    routeQuery([
      {
        fitbit_user_id: 'ABC123',
        access_token: 'stored-access',
        refresh_token: 'stored-refresh',
        expires_at: future,
        scope: 'activity heartrate',
      },
    ]);
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    await expect(getValidAccessToken()).resolves.toBe('stored-access');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes with Basic auth when the stored token is stale', async () => {
    routeQuery([
      {
        fitbit_user_id: 'ABC123',
        access_token: 'old',
        refresh_token: 'old-refresh',
        expires_at: new Date(Date.now() - 60_000),
        scope: 'activity',
      },
    ]);
    const fetchMock = tokenFetch({
      access_token: 'new-access',
      refresh_token: 'rotated',
      expires_in: 28800,
      token_type: 'Bearer',
      user_id: 'ABC123',
    });

    await expect(getValidAccessToken()).resolves.toBe('new-access');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toMatch(
      /^Basic /,
    );
  });

  it('throws when no tokens have been authorized', async () => {
    routeQuery([]);
    await expect(getValidAccessToken()).rejects.toThrow(/fitbit:auth/);
  });
});

describe('exchangeAuthorizationCode', () => {
  it('exchanges a code and returns the stored tokens', async () => {
    routeQuery([]);
    tokenFetch({
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 28800,
      token_type: 'Bearer',
      user_id: 'ABC123',
      scope: 'activity heartrate',
    });
    const stored = await exchangeAuthorizationCode('code123', 1000);
    expect(stored.fitbitUserId).toBe('ABC123');
    expect(stored.expiresAt).toBe(1000 + 28800);
  });
});
