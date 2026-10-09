import { query } from '../db';
import { logger } from '../logger';
import { googleTokenResponseSchema, type GoogleTokenResponse } from './types';

// Google OAuth 2.0 for the Google Calendar API: authorization-code exchange,
// refresh, and singleton-row token persistence. Mirrors
// services/googleHealth/oauth.ts exactly — same token endpoint, same
// refresh-token-only-on-first-consent behavior — but a separate consent and
// token row because the scope differs (calendar, not health).

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const EXPIRY_SKEW_S = 120;

// Full calendar scope: create the dedicated "Agon Training"/"Agon Meals"
// calendars AND manage their events. calendar.events alone can't create calendars.
export const SCOPE = 'https://www.googleapis.com/auth/calendar';

export interface GoogleCalendarStoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // UNIX seconds
  scope: string | null;
}

function credentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'google-calendar oauth: GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET must be set',
    );
  }
  return { clientId, clientSecret };
}

/** Consent URL — access_type=offline & prompt=consent to force a refresh token. */
export function authorizeUrl(): string {
  const { clientId } = credentials();
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  if (!redirectUri) {
    throw new Error(
      'google-calendar oauth: GOOGLE_CALENDAR_REDIRECT_URI must be set',
    );
  }
  const qs = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTH_URL}?${qs.toString()}`;
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
      `google-calendar oauth: token request failed (${res.status} ${res.statusText}) ${text}`,
    );
  }
  return googleTokenResponseSchema.parse(await res.json());
}

/** One-time: exchange the ?code from the consent redirect for tokens, and persist. */
export async function exchangeAuthorizationCode(
  code: string,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): Promise<GoogleCalendarStoredTokens> {
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  if (!redirectUri) {
    throw new Error(
      'google-calendar oauth: GOOGLE_CALENDAR_REDIRECT_URI must be set',
    );
  }
  const parsed = await postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  if (!parsed.refresh_token) {
    throw new Error(
      'google-calendar oauth: no refresh_token in the code exchange — re-run the ' +
        'consent with access_type=offline and prompt=consent',
    );
  }
  const stored = await persistTokens({
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: nowEpoch + parsed.expires_in,
    scope: parsed.scope ?? null,
  });
  logger.info('google-calendar tokens stored', { job: 'google-calendar-auth' });
  return stored;
}

async function refreshTokens(
  current: GoogleCalendarStoredTokens,
  nowEpoch: number,
): Promise<GoogleCalendarStoredTokens> {
  const parsed = await postToken({
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
  });
  return persistTokens({
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? current.refreshToken,
    expiresAt: nowEpoch + parsed.expires_in,
    scope: parsed.scope ?? current.scope,
  });
}

export async function getStoredTokens(): Promise<GoogleCalendarStoredTokens | null> {
  const { rows } = await query<{
    access_token: string;
    refresh_token: string;
    expires_at: Date;
    scope: string | null;
  }>(
    `SELECT access_token, refresh_token, expires_at, scope
       FROM public.google_calendar_oauth_tokens WHERE id = TRUE`,
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
  t: GoogleCalendarStoredTokens,
): Promise<GoogleCalendarStoredTokens> {
  await query(
    `INSERT INTO public.google_calendar_oauth_tokens
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
 * authorized yet (run `pnpm gcal:auth` first).
 */
export async function getValidAccessToken(
  nowEpoch: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const stored = await getStoredTokens();
  if (!stored) {
    throw new Error(
      'google-calendar oauth: no stored tokens — run `pnpm gcal:auth` to authorize first',
    );
  }
  if (accessTokenIsFresh(stored.expiresAt, nowEpoch)) return stored.accessToken;
  logger.info('google-calendar access token stale — refreshing', {
    job: 'google-calendar',
  });
  const refreshed = await refreshTokens(stored, nowEpoch);
  return refreshed.accessToken;
}
