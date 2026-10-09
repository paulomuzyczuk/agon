import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { exchangeAuthorizationCode } from '../services/googleHealth/oauth';
import { logger } from '../services/logger';

// One-time Google OAuth authorization for the Google Health API (CLI flow). No
// web server needed:
//
//   1. `pnpm gh:auth`             → prints the consent URL. Open it, approve.
//   2. The browser redirects to GOOGLE_HEALTH_REDIRECT_URI with `?code=...` in
//      the URL. The page itself won't load (nothing is listening) — that's fine;
//      copy the `code` value out of the address bar.
//   3. `pnpm gh:auth <code>`      → exchanges the code and stores the tokens.
//
// `access_type=offline` + `prompt=consent` are REQUIRED so Google returns a
// refresh token (without it the sync can't run headless). Refresh is automatic
// thereafter (services/googleHealth/oauth.ts).
//
// Google Cloud Console setup (first-timer walkthrough):
//   1. console.cloud.google.com → create a project (e.g. "agon").
//   2. APIs & Services → Library → enable the "Health API".
//   3. APIs & Services → OAuth consent screen → User type "External",
//      publishing status "Testing", add yourself as a Test user.
//   4. Credentials → Create Credentials → OAuth client ID → type "Web
//      application"; add GOOGLE_HEALTH_REDIRECT_URI as an Authorized redirect URI.
//   5. Copy the client id/secret + redirect URI into .env.local.

// Verified live 2026-07-24: scopes use the `googlehealth.` prefix + `.readonly`
// suffix (an earlier guess of `health.activity_and_fitness` failed invalid_scope).
// The run pipeline needs three: exercise sessions (activity_and_fitness), the
// route/GPS track (location — it IS gated separately, resolving the §8 open
// question), and per-sample HR (health_metrics_and_measurements).
//
// Workstream C (Fitbit → Google Health wellness migration) adds a FOURTH scope,
// `sleep`, for the sleep sessions. Steps/distance/floors/active-minutes fall under
// activity_and_fitness (already granted); resting HR + HRV under
// health_metrics_and_measurements (already granted); only sleep is gated
// separately (TODO(live): confirm the exact `googlehealth.sleep.readonly` string).
// Adding a scope forces a re-consent — expected, since the whole point of this
// migration is that Fitbit Web API tokens do NOT transfer to Google OAuth.
const SCOPE = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.location.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
].join(' ');

function authorizeUrl(): string {
  const clientId = process.env.GOOGLE_HEALTH_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_HEALTH_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    throw new Error(
      'google-health-auth: GOOGLE_HEALTH_CLIENT_ID and GOOGLE_HEALTH_REDIRECT_URI must be set',
    );
  }
  const qs = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPE,
    access_type: 'offline', // → refresh token
    prompt: 'consent', // force the refresh token even on re-auth
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${qs.toString()}`;
}

async function main(): Promise<void> {
  loadEnv();
  const code = process.argv[2] ?? process.env.GOOGLE_HEALTH_AUTH_CODE;

  if (!code) {
    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        'Step 1 — open this URL, approve access:',
        '',
        `  ${authorizeUrl()}`,
        '',
        'Step 2 — copy the `code` from the redirect URL and run:',
        '',
        '  pnpm gh:auth <code>',
        '',
      ].join('\n'),
    );
    return;
  }

  await exchangeAuthorizationCode(code);
  logger.info('google-health authorization complete', {
    job: 'google-health-auth',
  });
  // eslint-disable-next-line no-console
  console.log('\nAuthorized. Run `pnpm gh:sync` next.\n');
}

main()
  .catch((err) => {
    logger.error(
      'google-health-auth failed',
      { job: 'google-health-auth' },
      err,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
