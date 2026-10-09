import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { exchangeAuthorizationCode } from '../services/fitbit/oauth';
import { logger } from '../services/logger';

// One-time Fitbit OAuth authorization (CLI flow), same shape as strava-auth:
//
//   1. `pnpm fitbit:auth`         → prints the consent URL. Open it, approve.
//   2. The browser redirects to FITBIT_REDIRECT_URI with `?code=...`. The page
//      won't load (nothing is listening) — copy the `code` from the address bar.
//   3. `pnpm fitbit:auth <code>`  → exchanges the code and stores the tokens.
//
// Scopes: activity (steps/daily) + heartrate (intraday HR). Register the app at
// https://dev.fitbit.com/apps as a "Personal" app so intraday HR is granted.

const SCOPE = 'activity heartrate profile';

function authorizeUrl(): string {
  const clientId = process.env.FITBIT_CLIENT_ID;
  const redirectUri = process.env.FITBIT_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    throw new Error(
      'fitbit-auth: FITBIT_CLIENT_ID and FITBIT_REDIRECT_URI must be set',
    );
  }
  const qs = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPE,
  });
  return `https://www.fitbit.com/oauth2/authorize?${qs.toString()}`;
}

async function main(): Promise<void> {
  loadEnv();
  const code = process.argv[2] ?? process.env.FITBIT_AUTH_CODE;

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
        '  pnpm fitbit:auth <code>',
        '',
      ].join('\n'),
    );
    return;
  }

  const stored = await exchangeAuthorizationCode(code);
  logger.info('fitbit authorization complete', {
    job: 'fitbit-auth',
    fitbitUserId: stored.fitbitUserId,
  });
  // eslint-disable-next-line no-console
  console.log(
    `\nAuthorized Fitbit user ${stored.fitbitUserId}. Run \`pnpm fitbit:backfill --since=2026-07-01\` next.\n`,
  );
}

main()
  .catch((err) => {
    logger.error('fitbit-auth failed', { job: 'fitbit-auth' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
