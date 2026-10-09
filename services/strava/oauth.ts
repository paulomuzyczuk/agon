import { query } from '../db';
import { logger } from '../logger';
import { stravaTokenResponseSchema, type StravaTokenResponse } from './types';

// Strava OAuth: authorization-code exchange, refresh, and singleton-row token
// persistence. The refresh token is the durable credential — the access token
// lives ~6h — so it is stored in strava_oauth_tokens and reused, rather than
// re-running the browser consent each time.

const TOKEN_URL = 'https://www.strava.com/oauth/token';
// Refresh a little before the hard expiry so an in-flight backfill never races
// the boundary mid-run.
const EXPIRY_SKEW_S = 120;

export interface StoredTokens {
  athleteId: number;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // UNIX seconds
  scope: string | null;
}

function credentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'strava oauth: STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET must be set',
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
): Promise<StravaTokenResponse> {
  const { clientId, clientSecret } = credentials();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      ...body,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `strava oauth: token request failed (${res.status} ${res.statusText}) ${text}`,
    );
  }
  return stravaTokenResponseSchema.parse(await res.json());
}

/** One-time: exchange the ?code from the consent redirect for tokens, and persist. */
export async function exchangeAuthorizationCode(
  code: string,
): Promise<StoredTokens> {
  const parsed = await postToken({
    code,
    grant_type: 'authorization_code',
  });
  if (!parsed.athlete) {
    throw new Error(
      'strava oauth: authorization-code response missing athlete id',
    );
  }
  const stored = await persistTokens({
    athleteId: parsed.athlete.id,
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: parsed.expires_at,
    scope: parsed.scope ?? null,
  });
  logger.info('strava tokens stored', {
    job: 'strava-auth',
    athleteId: stored.athleteId,
  });
  return stored;
}

/** Refresh using the stored refresh token; Strava may rotate it, so re-persist. */
async function refreshTokens(current: StoredTokens): Promise<StoredTokens> {
  const parsed = await postToken({
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
  });
  return persistTokens({
    athleteId: current.athleteId,
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token, // may differ — Strava rotates
    expiresAt: parsed.expires_at,
    scope: parsed.scope ?? current.scope,
  });
}

export async function getStoredTokens(): Promise<StoredTokens | null> {
  const { rows } = await query<{
    athlete_id: string;
    access_token: string;
    refresh_token: string;
    expires_at: Date;
    scope: string | null;
  }>(
    `SELECT athlete_id, access_token, refresh_token, expires_at, scope
       FROM public.strava_oauth_tokens WHERE id = TRUE`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    athleteId: Number(row.athlete_id),
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: Math.floor(row.expires_at.getTime() / 1000),
    scope: row.scope,
  };
}

async function persistTokens(t: StoredTokens): Promise<StoredTokens> {
  await query(
    `INSERT INTO public.strava_oauth_tokens
       (id, athlete_id, access_token, refresh_token, expires_at, scope)
     VALUES (TRUE, $1, $2, $3, to_timestamp($4), $5)
     ON CONFLICT (id) DO UPDATE SET
       athlete_id    = EXCLUDED.athlete_id,
       access_token  = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at    = EXCLUDED.expires_at,
       scope         = EXCLUDED.scope`,
    [t.athleteId, t.accessToken, t.refreshToken, t.expiresAt, t.scope],
  );
  return t;
}

/**
 * Returns a usable access token, transparently refreshing (and persisting) if
 * the stored one is within the skew window of expiry. Throws if no tokens have
 * been authorized yet (run `pnpm strava:auth` first).
 */
export async function getValidAccessToken(
  nowEpoch: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const stored = await getStoredTokens();
  if (!stored) {
    throw new Error(
      'strava oauth: no stored tokens — run `pnpm strava:auth` to authorize first',
    );
  }
  if (accessTokenIsFresh(stored.expiresAt, nowEpoch)) return stored.accessToken;
  logger.info('strava access token stale — refreshing', { job: 'strava' });
  const refreshed = await refreshTokens(stored);
  return refreshed.accessToken;
}
