import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { attachSuggestionToPlannedSession } from '../services/routeSuggestions';
import { logger } from '../services/logger';

// Attach a saved route suggestion to a planned_sessions row — the composition
// step (CLAUDE.md #6) that lets later analysis compare the planned route to the
// actual run's GPS (run_streams). A deliberate write, kept off the read-only MCP
// layer (mirrors gcal sync being CLI-only).
//
//   pnpm route:attach <suggestion-id> <planned-session-id>

async function main(): Promise<void> {
  loadEnv();
  const [suggestionId, plannedSessionId] = process.argv
    .slice(2)
    .filter((a) => !a.startsWith('--'));
  if (!suggestionId || !plannedSessionId) {
    throw new Error(
      'usage: pnpm route:attach <suggestion-id> <planned-session-id>',
    );
  }
  const { plannedDate, sessionKind } = await attachSuggestionToPlannedSession(
    suggestionId,
    plannedSessionId,
  );
  // eslint-disable-next-line no-console
  console.log(
    `\nAttached route ${suggestionId} to the ${sessionKind} planned for ${plannedDate}.\n`,
  );
  logger.info('route:attach done', {
    job: 'route-attach',
    suggestionId,
    plannedSessionId,
  });
}

main()
  .catch((err) => {
    logger.error('attach-route failed', { job: 'route-attach' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
