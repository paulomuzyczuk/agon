import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { authorizeUrl, exchangeAuthorizationCode } from '../services/googleCalendar';
import { logger } from '../services/logger';

// One-time Google Calendar authorization (mirrors scripts/google-health-auth.ts).
//
// Prerequisites (Google Cloud Console — you can reuse the same project as Google
// Health): enable the Google Calendar API, add the scope
// https://www.googleapis.com/auth/calendar to the OAuth consent screen, and add
// GOOGLE_CALENDAR_REDIRECT_URI to the OAuth client's Authorized redirect URIs.
// Set GOOGLE_CALENDAR_CLIENT_ID / _SECRET / _REDIRECT_URI in .env.local.
//
//   pnpm gcal:auth            # prints the consent URL
//   pnpm gcal:auth <code>     # exchanges the ?code from the redirect

async function main(): Promise<void> {
  loadEnv();
  const code = process.argv[2] ?? process.env.GOOGLE_CALENDAR_AUTH_CODE;

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
        '  pnpm gcal:auth <code>',
        '',
      ].join('\n'),
    );
    return;
  }

  await exchangeAuthorizationCode(code);
  logger.info('google-calendar authorization complete', {
    job: 'google-calendar-auth',
  });
  // eslint-disable-next-line no-console
  console.log('\nAuthorized. Run `pnpm gcal:sync` next.\n');
}

main()
  .catch((err) => {
    logger.error(
      'google-calendar-auth failed',
      { job: 'google-calendar-auth' },
      err,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
