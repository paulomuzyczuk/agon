import { query } from '../db';
import { logger } from '../logger';
import { fitbitTokenResponseSchema } from './types';

// Fitbit OAuth 2.0: authorization-code exchange, refresh, and singleton-row
// token persistence (single-user platform). Fitbit's token endpoint uses HTTP
// Basic auth (base64 of client_id:client_secret) with a form-urlencoded body,
// and rotates the refresh token on every refresh.

const TOKEN_URL = 'https://api.fitbit.com/oauth2/token';
const EXPIRY_SKEW_S = 120;

export interface FitbitStoredTokens {
  fitbitUserId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // UNIX seconds
  scope: string | null;
}

function credentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.FITBIT_CLIENT_ID;
  const clientSecret = process.env.FITBIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'fitbit oauth: FITBIT_CLIENT_ID and FITBIT_CLIENT_SECRET must be set',
    );
  }
  return { clientId, clientSecret };
}

export function accessTokenIsFresh(
  expiresAtEpoch: number,
  nowEpoch: number,
  skewS: number = EXPIRY_SKEW_S,
): boolean {
  return expiresAtEpoch - skewS > nowEpoch;
}

async function postToken(
  body: Record<string, string>,
  nowEpoch: number,
): Promise<FitbitStoredTokens> {
  const { clientId, clientSecret } = credentials();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `fitbit oauth: token request failed (${res.status} ${res.statusText}) ${text}`,
    );
  }
  const parsed = fitbitTokenResponseSchema.parse(await res.json());
  return {
    fitbitUserId: parsed.user_id,
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: nowEpoch + parsed.expires_in,
    scope: parsed.scope ?? null,
  };
}

/** One-time: exchange the ?code from the consent redirect for tokens, persist. */
export async function exchangeAuthorizationCode(
  code: string,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): Promise<FitbitStoredTokens> {
  const redirectUri = process.env.FITBIT_REDIRECT_URI;
  if (!redirectUri) {
    throw new Error('fitbit oauth: FITBIT_REDIRECT_URI must be set');
  }
  const tokens = await postToken(
    { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
    nowEpoch,
  );
  await persistTokens(tokens);
  logger.info('fitbit tokens stored', {
    job: 'fitbit-auth',
    fitbitUserId: tokens.fitbitUserId,
  });
  return tokens;
}

async function refreshTokens(
  current: FitbitStoredTokens,
  nowEpoch: number,
): Promise<FitbitStoredTokens> {
  const refreshed = await postToken(
    { grant_type: 'refresh_token', refresh_token: current.refreshToken },
    nowEpoch,
  );
  // Fitbit's refresh response echoes user_id; keep the known one if blank.
  return persistTokens({
    ...refreshed,
    fitbitUserId: refreshed.fitbitUserId || current.fitbitUserId,
    scope: refreshed.scope ?? current.scope,
  });
}

export async function getStoredTokens(): Promise<FitbitStoredTokens | null> {
  const { rows } = await query<{
    fitbit_user_id: string;
    access_token: string;
    refresh_token: string;
    expires_at: Date;
    scope: string | null;
  }>(
    `SELECT fitbit_user_id, access_token, refresh_token, expires_at, scope
       FROM public.fitbit_oauth_tokens WHERE id = TRUE`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    fitbitUserId: row.fitbit_user_id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: Math.floor(row.expires_at.getTime() / 1000),
    scope: row.scope,
  };
}

async function persistTokens(
  t: FitbitStoredTokens,
): Promise<FitbitStoredTokens> {
  await query(
    `INSERT INTO public.fitbit_oauth_tokens
       (id, fitbit_user_id, access_token, refresh_token, expires_at, scope)
     VALUES (TRUE, $1, $2, $3, to_timestamp($4), $5)
     ON CONFLICT (id) DO UPDATE SET
       fitbit_user_id = EXCLUDED.fitbit_user_id,
       access_token   = EXCLUDED.access_token,
       refresh_token  = EXCLUDED.refresh_token,
       expires_at     = EXCLUDED.expires_at,
       scope          = EXCLUDED.scope`,
    [t.fitbitUserId, t.accessToken, t.refreshToken, t.expiresAt, t.scope],
  );
  return t;
}

/** A usable access token, refreshing + persisting if the stored one is stale. */
export async function getValidAccessToken(
  nowEpoch: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const stored = await getStoredTokens();
  if (!stored) {
    throw new Error(
      'fitbit oauth: no stored tokens — run `pnpm fitbit:auth` to authorize first',
    );
  }
  if (accessTokenIsFresh(stored.expiresAt, nowEpoch)) return stored.accessToken;
  logger.info('fitbit access token stale — refreshing', { job: 'fitbit' });
  const refreshed = await refreshTokens(stored, nowEpoch);
  return refreshed.accessToken;
}
