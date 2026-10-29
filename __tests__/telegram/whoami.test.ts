import { parseCommand, CommandError } from '@/services/telegram/commands';
import { executeCommand, contextFor } from '@/services/telegram/handlers';
import { dispatchTelegramUpdate } from '@/services/telegram/dispatch';

// /whoami (MZY-406, install audit F-19): the owner reads their chat id from the
// running bot instead of calling getUpdates, which fights the long-poll listener.

describe('/whoami', () => {
  it('parses, with or without the @botname suffix', () => {
    expect(parseCommand('/whoami')).toEqual({ kind: 'whoami' });
    expect(parseCommand('/whoami@agon_bot')).toEqual({ kind: 'whoami' });
  });

  it('is still unknown-command safe for lookalikes', () => {
    expect(() => parseCommand('/whoamiii')).toThrow(CommandError);
  });

  it('replies with the chat id and the env line to set', async () => {
    const reply = await executeCommand(
      { kind: 'whoami' },
      { today: '2026-10-29', chatId: 123456789 },
    );
    expect(reply).toContain('123456789');
    expect(reply).toContain('TELEGRAM_OWNER_CHAT_ID=123456789');
  });

  it('does not invent an id when the message carries none', async () => {
    const reply = await executeCommand(
      { kind: 'whoami' },
      { today: '2026-10-29' },
    );
    expect(reply).toContain('No chat id');
  });

  it('contextFor stamps the chat id and honours a date override', () => {
    expect(contextFor(7, '2026-01-02')).toMatchObject({
      chatId: 7,
      today: '2026-01-02',
    });
  });

  it('dispatch passes the sender chat id through to the reply (first run, no owner yet)', async () => {
    const sent: { chatId: number; text: string }[] = [];
    await dispatchTelegramUpdate(
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: 42, type: 'private' },
          text: '/whoami',
        },
      } as never,
      {
        sendMessage: async (chatId, text) => {
          sent.push({ chatId, text });
        },
        downloadVoice: async () => {
          throw new Error('not used');
        },
        getCompletion: () => {
          throw new Error('not used');
        },
        getTranscription: () => {
          throw new Error('not used');
        },
        ownerChatId: null,
        today: '2026-10-29',
      },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe(42);
    expect(sent[0]!.text).toContain('TELEGRAM_OWNER_CHAT_ID=42');
  });
});
