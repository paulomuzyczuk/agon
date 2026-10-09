import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { exchangeAuthorizationCode } from '../services/strava/oauth';
import { logger } from '../services/logger';

// One-time Strava OAuth authorization (CLI flow). No web server needed:
//
//   1. `pnpm strava:auth`            → prints the consent URL. Open it, approve.
//   2. The browser redirects to STRAVA_REDIRECT_URI with `?code=...` in the URL.
//      The page itself won't load (nothing is listening) — that's fine; copy the
//      `code` value out of the address bar.
//   3. `pnpm strava:auth <code>`     → exchanges the code and stores the tokens.
//
// `activity:read_all` is requested so private activities are included in the
// backfill. Refresh is automatic thereafter (services/strava/oauth.ts).

const SCOPE = 'read,activity:read_all';

function authorizeUrl(): string {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const redirectUri = process.env.STRAVA_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    throw new Error(
      'strava-auth: STRAVA_CLIENT_ID and STRAVA_REDIRECT_URI must be set',
    );
  }
  const qs = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    approval_prompt: 'auto',
    scope: SCOPE,
  });
  return `https://www.strava.com/oauth/authorize?${qs.toString()}`;
}

async function main(): Promise<void> {
  loadEnv();
  const code = process.argv[2] ?? process.env.STRAVA_AUTH_CODE;

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
        '  pnpm strava:auth <code>',
        '',
      ].join('\n'),
    );
    return;
  }

  const stored = await exchangeAuthorizationCode(code);
  logger.info('strava authorization complete', {
    job: 'strava-auth',
    athleteId: stored.athleteId,
    scope: stored.scope ?? undefined,
  });
  // eslint-disable-next-line no-console
  console.log(
    `\nAuthorized athlete ${stored.athleteId}. Run \`pnpm strava:backfill\` next.\n`,
  );
}

main()
  .catch((err) => {
    logger.error('strava-auth failed', { job: 'strava-auth' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
