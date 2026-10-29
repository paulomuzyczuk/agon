import { NextResponse } from 'next/server';
import { logger } from '@/services/logger';
import {
  dispatchTelegramUpdate,
  parseOwnerChatId,
  sendMessage,
  downloadFile,
  telegramUpdateSchema,
  getBotToken,
  type TelegramDeps,
} from '@/services/telegram';
import { getCompletionClient } from '@/services/llm/completion';
import { getTranscriptionClient } from '@/services/llm/transcription';

// App-side entry point for the Telegram capture pipeline (Build order step 4 —
// the DEPLOYMENT layer). Handles TEXT commands (/weight, /bf, /sweat, /week,
// /sync, /undo) and VOICE notes (download → transcribe → parse → log) through the
// same dispatchTelegramUpdate path the local poll listener uses. Voice requires
// AGON_LLM_API_KEY + a transcription provider; on a Linux host use the hosted
// openai transcription rather than local mlx-whisper.
//
// Security: Telegram signs webhook calls with a secret token in the
// X-Telegram-Bot-Api-Secret-Token header (set when registering the webhook). We
// reject anything that doesn't match TELEGRAM_WEBHOOK_SECRET so the endpoint
// can't be driven by arbitrary callers (when the secret is unset the check is
// skipped; dispatchTelegramUpdate still answers only TELEGRAM_OWNER_CHAT_ID,
// MZY-418). Always returns 200 on handled updates so
// Telegram doesn't retry; replies are sent via the Bot API.
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<NextResponse> {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const parsed = telegramUpdateSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'bad update' },
      { status: 400 },
    );
  }

  const token = getBotToken();
  const deps: TelegramDeps = {
    sendMessage: (chatId, text) => sendMessage(chatId, text, token),
    downloadVoice: (fileId) => downloadFile(fileId, token),
    getCompletion: () => getCompletionClient(),
    getTranscription: () => getTranscriptionClient(),
    ownerChatId: parseOwnerChatId(process.env.TELEGRAM_OWNER_CHAT_ID),
  };

  try {
    await dispatchTelegramUpdate(parsed.data, deps);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error(
      'telegram webhook failed',
      { route: '/api/telegram/webhook' },
      err,
    );
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
