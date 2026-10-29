import { logger } from '../logger';

// Who may talk to the bot (MZY-418). A Telegram bot is reachable by username, so
// without this anyone who finds it could log weights, run /sync or /undo, spend
// the routing quota with /route, or push audio through transcription. Both entry
// points (the poll listener and the webhook) go through dispatchTelegramUpdate,
// which asks here first, so there is one gate.
//
// Policy, deliberately fail-closed:
//  * TELEGRAM_OWNER_CHAT_ID set: only that chat is answered. Anyone else is
//    dropped silently (no reply that confirms a live bot), with a warning log.
//  * Not set: nobody is trusted yet, so only /whoami is answered (it hands the
//    sender their own chat id to configure). Everything else gets a one-line
//    setup hint. A stranger learns nothing but their own id.

export interface SenderMessage {
  chat: { id: number };
  from?: { id: number };
  text?: string;
}

export type Access =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'not-owner' | 'no-owner-configured';
      reply?: string;
    };

/**
 * The configured owner chat id, or null when unset or not a valid Telegram id.
 * Groups have negative ids and users positive ones, so any non-zero integer is
 * accepted; blank, `0`, text or a placeholder is "not configured".
 */
export function parseOwnerChatId(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed || !/^-?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n !== 0 ? n : null;
}

const WHOAMI = /^\/whoami(?:@\w+)?(?:\s|$)/i;

export const SETUP_HINT =
  'This bot is not set up yet. Send /whoami, then put the id it replies with in ' +
  'TELEGRAM_OWNER_CHAT_ID in .env.local and restart the bot.';

export function checkSender(
  message: SenderMessage,
  ownerChatId: number | null,
): Access {
  if (ownerChatId === null) {
    if (message.text && WHOAMI.test(message.text.trim())) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: 'no-owner-configured',
      reply: SETUP_HINT,
    };
  }
  // The chat must be the owner's. When Telegram names the sender, that has to be
  // the owner too, so a group the owner id happens to be reused for can't be
  // used by its other members.
  const senderOk =
    message.from === undefined || message.from.id === ownerChatId;
  if (message.chat.id === ownerChatId && senderOk) return { allowed: true };
  return { allowed: false, reason: 'not-owner' };
}

/** Log a refused message without its content: only the ids and the kind. */
export function logRefused(
  access: Extract<Access, { allowed: false }>,
  message: SenderMessage & { voice?: unknown },
): void {
  logger.warn('telegram message refused', {
    job: 'telegram-access',
    reason: access.reason,
    chatId: message.chat.id,
    kind: message.voice ? 'voice' : message.text ? 'text' : 'other',
  });
}
