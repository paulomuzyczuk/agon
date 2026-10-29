import {
  checkSender,
  parseOwnerChatId,
  SETUP_HINT,
} from '@/services/telegram/access';
import { dispatchTelegramUpdate } from '@/services/telegram/dispatch';
import type { TelegramDeps } from '@/services/telegram/dispatch';
import { telegramUpdateSchema } from '@/services/telegram/api';

// Only the owner may use the bot (MZY-418). A Telegram bot is reachable by
// username, so a stranger's text, command or voice note must never reach a
// handler, transcription or the database.

const OWNER = 1001;

describe('parseOwnerChatId', () => {
  it.each([
    ['1001', 1001],
    [' 1001 ', 1001],
    ['-100123456', -100123456], // a group id
  ])('reads %p as %p', (raw, expected) => {
    expect(parseOwnerChatId(raw)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    '   ',
    '0',
    'abc',
    '12.5',
    '1e3',
    '# comment',
    'NaN',
  ])('treats %p as not configured', (raw) => {
    expect(parseOwnerChatId(raw)).toBeNull();
  });

  it('rejects an id too large to compare exactly', () => {
    expect(parseOwnerChatId('99999999999999999999')).toBeNull();
  });
});

describe('checkSender with an owner configured', () => {
  it('answers the owner', () => {
    expect(
      checkSender(
        { chat: { id: OWNER }, from: { id: OWNER }, text: '/week' },
        OWNER,
      ),
    ).toEqual({ allowed: true });
  });

  it('answers the owner when Telegram omits the sender', () => {
    expect(
      checkSender({ chat: { id: OWNER }, text: '/week' }, OWNER).allowed,
    ).toBe(true);
  });

  it('drops a stranger, silently', () => {
    const r = checkSender(
      { chat: { id: 2002 }, from: { id: 2002 }, text: '/sync' },
      OWNER,
    );
    expect(r).toEqual({ allowed: false, reason: 'not-owner' });
  });

  it('drops a stranger who asks for /whoami (no early opening once configured)', () => {
    expect(
      checkSender(
        { chat: { id: 2002 }, from: { id: 2002 }, text: '/whoami' },
        OWNER,
      ).allowed,
    ).toBe(false);
  });

  it('drops someone else posting in the owner chat', () => {
    expect(
      checkSender(
        { chat: { id: OWNER }, from: { id: 2002 }, text: '/undo' },
        OWNER,
      ).allowed,
    ).toBe(false);
  });

  it('does not match on a prefix or lookalike id', () => {
    expect(
      checkSender({ chat: { id: 10010 }, text: '/week' }, OWNER).allowed,
    ).toBe(false);
  });
});

describe('checkSender with no owner configured (first run)', () => {
  it('allows only /whoami', () => {
    expect(
      checkSender({ chat: { id: 5 }, text: '/whoami' }, null).allowed,
    ).toBe(true);
    expect(
      checkSender({ chat: { id: 5 }, text: '/whoami@my_bot' }, null).allowed,
    ).toBe(true);
  });

  it.each(['/weight 80', '/sync', '/undo', '/route 10', 'hello', undefined])(
    'refuses %p with a setup hint',
    (text) => {
      const r = checkSender({ chat: { id: 5 }, text }, null);
      expect(r).toEqual({
        allowed: false,
        reason: 'no-owner-configured',
        reply: SETUP_HINT,
      });
    },
  );

  it('does not treat a lookalike command as /whoami', () => {
    expect(
      checkSender({ chat: { id: 5 }, text: '/whoamiii' }, null).allowed,
    ).toBe(false);
    expect(
      checkSender({ chat: { id: 5 }, text: '/x /whoami' }, null).allowed,
    ).toBe(false);
  });
});

describe('dispatchTelegramUpdate gate', () => {
  function harness(ownerChatId: number | null) {
    const sent: { chatId: number; text: string }[] = [];
    const touched: string[] = [];
    const deps: TelegramDeps = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      downloadVoice: async () => {
        touched.push('download');
        throw new Error('stranger audio must never be downloaded');
      },
      getCompletion: () => {
        touched.push('llm');
        throw new Error('must not run');
      },
      getTranscription: () => {
        touched.push('transcribe');
        throw new Error('must not run');
      },
      ownerChatId,
      today: '2026-10-29',
    };
    return { deps, sent, touched };
  }
  const update = (message: object) =>
    telegramUpdateSchema.parse({ update_id: 1, message });

  it('a stranger gets no reply and a voice note is never downloaded or transcribed', async () => {
    const h = harness(OWNER);
    await dispatchTelegramUpdate(
      update({
        chat: { id: 2002 },
        from: { id: 2002 },
        voice: { file_id: 'F' },
      }),
      h.deps,
    );
    await dispatchTelegramUpdate(
      update({ chat: { id: 2002 }, from: { id: 2002 }, text: '/sync' }),
      h.deps,
    );
    expect(h.sent).toEqual([]);
    expect(h.touched).toEqual([]);
  });

  it('the owner is answered', async () => {
    const h = harness(OWNER);
    await dispatchTelegramUpdate(
      update({ chat: { id: OWNER }, from: { id: OWNER }, text: '/whoami' }),
      h.deps,
    );
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.chatId).toBe(OWNER);
  });

  it('first run: /whoami works, anything else gets the setup hint and nothing runs', async () => {
    const h = harness(null);
    await dispatchTelegramUpdate(
      update({ chat: { id: 9 }, text: '/whoami' }),
      h.deps,
    );
    await dispatchTelegramUpdate(
      update({ chat: { id: 9 }, text: '/weight 80' }),
      h.deps,
    );
    await dispatchTelegramUpdate(
      update({ chat: { id: 9 }, voice: { file_id: 'F' } }),
      h.deps,
    );
    expect(h.sent.map((m) => m.text)).toEqual([
      expect.stringContaining('TELEGRAM_OWNER_CHAT_ID=9'),
      SETUP_HINT,
      SETUP_HINT,
    ]);
    expect(h.touched).toEqual([]);
  });

  it('keeps the sender id when parsing an update', () => {
    const parsed = telegramUpdateSchema.parse({
      update_id: 1,
      message: { chat: { id: 1 }, from: { id: 2 }, text: 'x' },
    });
    expect(parsed.message?.from?.id).toBe(2);
  });
});
