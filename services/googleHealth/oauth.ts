import { query } from '../db';
import { logger } from '../logger';
import { googleTokenResponseSchema, type GoogleTokenResponse } from './types';

// Google OAuth 2.0 for the Google Health API: authorization-code exchange,
// refresh, and singleton-row token persistence (single-user platform). Mirrors
// services/strava/oauth.ts + services/fitbit/oauth.ts. Google's token endpoint
// takes a form-urlencoded body and returns a refresh_token ONLY on the first
// consent (access_type=offline & prompt=consent) — a refresh response omits it,
// so the stored refresh token is reused across refreshes.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Refresh a little before the hard expiry so an in-flight sync never races the
// boundary mid-pull.
const EXPIRY_SKEW_S = 120;

export interface GoogleHealthStoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // UNIX seconds
  scope: string | null;
}

function credentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_HEALTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_HEALTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'google-health oauth: GOOGLE_HEALTH_CLIENT_ID and GOOGLE_HEALTH_CLIENT_SECRET must be set',
    );
  }
  return { clientId, clientSecret };
}

/** Pure freshness check — exported for unit testing the refresh decision. */
export function accessTokenIsFresh(
  expiresAtEpoch: number,
  nowEpoch: number,
  skewS: number = EXPIRY_SKEW_S,
): boolean {
  return expiresAtEpoch - skewS > nowEpoch;
}

async function postToken(
  body: Record<string, string>,
): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret } = credentials();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      ...body,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `google-health oauth: token request failed (${res.status} ${res.statusText}) ${text}`,
    );
  }
  return googleTokenResponseSchema.parse(await res.json());
}

/** One-time: exchange the ?code from the consent redirect for tokens, and persist. */
export async function exchangeAuthorizationCode(
  code: string,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): Promise<GoogleHealthStoredTokens> {
  const redirectUri = process.env.GOOGLE_HEALTH_REDIRECT_URI;
  if (!redirectUri) {
    throw new Error(
      'google-health oauth: GOOGLE_HEALTH_REDIRECT_URI must be set',
    );
  }
  const parsed = await postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  if (!parsed.refresh_token) {
    // Without offline access + a forced consent, Google returns no refresh token
    // and the integration can't run headless. Fail loudly at auth time.
    throw new Error(
      'google-health oauth: no refresh_token in the code exchange — re-run the ' +
        'consent with access_type=offline and prompt=consent',
    );
  }
  const stored = await persistTokens({
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: nowEpoch + parsed.expires_in,
    scope: parsed.scope ?? null,
  });
  logger.info('google-health tokens stored', { job: 'google-health-auth' });
  return stored;
}

/** Refresh using the stored refresh token. Google reuses it, so keep it if absent. */
async function refreshTokens(
  current: GoogleHealthStoredTokens,
  nowEpoch: number,
): Promise<GoogleHealthStoredTokens> {
  const parsed = await postToken({
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
  });
  return persistTokens({
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? current.refreshToken, // absent on refresh
    expiresAt: nowEpoch + parsed.expires_in,
    scope: parsed.scope ?? current.scope,
  });
}

export async function getStoredTokens(): Promise<GoogleHealthStoredTokens | null> {
  const { rows } = await query<{
    access_token: string;
    refresh_token: string;
    expires_at: Date;
    scope: string | null;
  }>(
    `SELECT access_token, refresh_token, expires_at, scope
       FROM public.google_health_oauth_tokens WHERE id = TRUE`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: Math.floor(row.expires_at.getTime() / 1000),
    scope: row.scope,
  };
}

async function persistTokens(
  t: GoogleHealthStoredTokens,
): Promise<GoogleHealthStoredTokens> {
  await query(
    `INSERT INTO public.google_health_oauth_tokens
       (id, access_token, refresh_token, expires_at, scope)
     VALUES (TRUE, $1, $2, to_timestamp($3), $4)
     ON CONFLICT (id) DO UPDATE SET
       access_token  = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at    = EXCLUDED.expires_at,
       scope         = EXCLUDED.scope`,
    [t.accessToken, t.refreshToken, t.expiresAt, t.scope],
  );
  return t;
}

/**
 * Returns a usable access token, transparently refreshing (and persisting) if the
 * stored one is within the skew window of expiry. Throws if no tokens have been
 * authorized yet (run `pnpm gh:auth` first).
 */
export async function getValidAccessToken(
  nowEpoch: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const stored = await getStoredTokens();
  if (!stored) {
    throw new Error(
      'google-health oauth: no stored tokens — run `pnpm gh:auth` to authorize first',
    );
  }
  if (accessTokenIsFresh(stored.expiresAt, nowEpoch)) return stored.accessToken;
  logger.info('google-health access token stale — refreshing', {
    job: 'google-health',
  });
  const refreshed = await refreshTokens(stored, nowEpoch);
  return refreshed.accessToken;
}
