import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import {
  getBotToken,
  getUpdates,
  sendMessage,
  downloadFile,
  dispatchTelegramUpdate,
  type TelegramDeps,
} from '../services/telegram';
import { getCompletionClient } from '../services/llm/completion';
import { getTranscriptionClient } from '../services/llm/transcription';

// Local, zero-infrastructure way to run the bot: long-poll Telegram for messages
// and reply — no public URL, tunnel, or VPS needed. The production path is the
// webhook route (app/api/telegram/webhook); this is for testing on your laptop.
//
//   pnpm telegram:poll        (needs TELEGRAM_BOT_TOKEN in .env.local + `pnpm db:up`)
//
// Telegram only allows getUpdates when NO webhook is registered — which is the
// case until you deploy. Ctrl-C to stop.

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const POLL_RETRY_BASE_MS = 1000;
const POLL_RETRY_MAX_MS = 30_000;

async function main(): Promise<void> {
  loadEnv();
  const token = getBotToken();
  logger.info('telegram poll started', { job: 'telegram-poll' });
  // eslint-disable-next-line no-console
  console.log(
    '\nListening for Telegram messages… send your bot a command. Ctrl-C to stop.\n',
  );

  let running = true;
  process.on('SIGINT', () => {
    running = false;
    // eslint-disable-next-line no-console
    console.log('\nStopping…');
  });

  // Text works with no LLM/Whisper setup; the clients are built lazily so a voice
  // note is the only thing that requires AGON_LLM_API_KEY + mlx-whisper.
  const deps: TelegramDeps = {
    sendMessage: (chatId, text) => sendMessage(chatId, text, token),
    downloadVoice: (fileId) => downloadFile(fileId, token),
    getCompletion: () => getCompletionClient(),
    getTranscription: () => getTranscriptionClient(),
  };

  // offset = last handled update_id + 1; 0 means "give me everything pending".
  let offset = 0;
  let retryDelayMs = POLL_RETRY_BASE_MS;
  while (running) {
    let updates;
    try {
      updates = await getUpdates(offset, token);
      retryDelayMs = POLL_RETRY_BASE_MS; // reset backoff after a successful call
    } catch (err) {
      // A network blip (or a Telegram-side hiccup) must not kill the whole
      // listener — found live 2026-08-26: an unhandled `fetch failed` from
      // getUpdates crashed the process twice in under 20 minutes, silently
      // ending capture until someone noticed and restarted it by hand. Back
      // off and keep polling instead.
      logger.warn('telegram poll: getUpdates failed, retrying', {
        job: 'telegram-poll',
        retryDelayMs,
        err: err instanceof Error ? err.message : String(err),
      });
      await sleep(retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, POLL_RETRY_MAX_MS);
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1; // ack: don't re-fetch this one
      try {
        await dispatchTelegramUpdate(update, deps);
      } catch (err) {
        logger.error(
          'telegram poll: handling failed',
          { job: 'telegram-poll' },
          err,
        );
        const chatId = update.message?.chat.id;
        if (chatId !== undefined) {
          await sendMessage(
            chatId,
            '⚠️ Something went wrong handling that — check the logs.',
            token,
          ).catch(() => undefined);
        }
      }
    }
  }
}

main()
  .catch((err) => {
    logger.error('telegram poll crashed', { job: 'telegram-poll' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
