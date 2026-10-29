import { z } from 'zod';

// Thin, typed client for the Telegram Bot API calls we make: send a reply, and
// (for local testing) long-poll for incoming messages. `fetch` is the Node
// global; tests stub it. The bot token comes from env and is read lazily so
// importing this module never requires it (unit tests don't need a token).

const API_BASE = 'https://api.telegram.org';

export function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error(
      'telegram: TELEGRAM_BOT_TOKEN must be set (get one from @BotFather)',
    );
  }
  return token;
}

// Every Bot API response is wrapped in { ok, result?, description? }.
const envelopeSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
});

async function callApi(
  method: string,
  token: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const envelope = envelopeSchema.parse(await res.json());
  if (!envelope.ok) {
    throw new Error(
      `telegram: ${method} failed — ${envelope.description ?? `HTTP ${res.status}`}`,
    );
  }
  return envelope.result;
}

/** Send a text message to a chat. */
export async function sendMessage(
  chatId: number,
  text: string,
  token: string = getBotToken(),
): Promise<void> {
  await callApi('sendMessage', token, { chat_id: chatId, text });
}

// The slice of an Update we act on: a message with a chat id, and either text or
// a voice note (voice notes carry a file_id we resolve + download).
export const telegramUpdateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      chat: z.object({ id: z.number() }),
      // Who sent it; absent for channel posts. Checked against the owner (access.ts).
      from: z.object({ id: z.number() }).optional(),
      text: z.string().optional(),
      voice: z
        .object({
          file_id: z.string(),
          mime_type: z.string().optional(),
          duration: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

const fileInfoSchema = z.object({ file_path: z.string() });

export interface TelegramFile {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

/**
 * Download a file (e.g. a voice note) by its file_id: resolve the file path via
 * getFile, then GET it from the file endpoint. Telegram voice notes are OGG/Opus.
 */
export async function downloadFile(
  fileId: string,
  token: string = getBotToken(),
): Promise<TelegramFile> {
  const info = await callApi('getFile', token, { file_id: fileId });
  const { file_path } = fileInfoSchema.parse(info);
  const res = await fetch(`${API_BASE}/file/bot${token}/${file_path}`);
  if (!res.ok) {
    throw new Error(
      `telegram: file download failed (${res.status} ${res.statusText})`,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const filename = file_path.split('/').pop() || 'voice.oga';
  return { bytes, filename, mimeType: 'audio/ogg' };
}

/**
 * Long-poll for updates newer than `offset`. Telegram holds the connection up to
 * `timeoutS` seconds if nothing has arrived, so the caller's loop doesn't busy-spin.
 * Only usable when no webhook is registered (the two delivery modes are exclusive).
 */
export async function getUpdates(
  offset: number,
  token: string = getBotToken(),
  timeoutS = 30,
): Promise<TelegramUpdate[]> {
  const result = await callApi('getUpdates', token, {
    offset,
    timeout: timeoutS,
  });
  return z.array(telegramUpdateSchema).parse(result);
}
