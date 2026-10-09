import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import {
  FakeCompletionClient,
  FakeTranscriptionClient,
} from '@/services/llm/fakes';
import {
  dispatchTelegramUpdate,
  type TelegramDeps,
  type TelegramUpdate,
} from '@/services/telegram';

// Integration lane — the full dispatch path (text + voice) against a live DB,
// with fake transcription/completion clients so no Whisper, model, or network is
// touched. Proves routing, persistence, and the reply the user would receive.

const DATE = '2026-09-05';
const CHAT = 55;

// Collect replies the bot would send.
let sent: Array<{ chatId: number; text: string }> = [];

function deps(completion: FakeCompletionClient, transcript = ''): TelegramDeps {
  return {
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text });
    },
    downloadVoice: async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      filename: 'note.oga',
      mimeType: 'audio/ogg',
    }),
    getCompletion: () => completion,
    getTranscription: () => new FakeTranscriptionClient(transcript),
    today: DATE,
  };
}

function textUpdate(text: string): TelegramUpdate {
  return { update_id: 1, message: { chat: { id: CHAT }, text } };
}
function voiceUpdate(): TelegramUpdate {
  return {
    update_id: 2,
    message: { chat: { id: CHAT }, voice: { file_id: 'F' } },
  };
}

beforeAll(() => loadEnv());
afterEach(async () => {
  sent = [];
  await query('DELETE FROM public.body_metrics WHERE date = $1', [DATE]);
  await query('DELETE FROM public.qualitative_logs WHERE date = $1', [DATE]);
  await query('DELETE FROM public.capture_events');
});
afterAll(() => closeDbPool());

describe('dispatchTelegramUpdate — text', () => {
  it('routes a text command, writes to the DB, and replies', async () => {
    // completion is unused for text commands.
    const completion = new FakeCompletionClient(() => ({}));
    await dispatchTelegramUpdate(textUpdate('/weight 74.5'), deps(completion));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/Logged weight 74.5 kg/);
    const { rows } = await query(
      'SELECT 1 FROM public.body_metrics WHERE date = $1',
      [DATE],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('dispatchTelegramUpdate — voice', () => {
  it('transcribes, auto-classifies, ingests, and replies with a summary', async () => {
    // One fake model that answers BOTH the classify call and the body-parse call,
    // keyed on the prompt id — exactly how the real pipeline chains them.
    const completion = new FakeCompletionClient((req) => {
      if (req.prompt.id === 'classify-capture') return { capture_type: 'body' };
      return { weight_kg: 75.2, body_fat_pct: 20.1, notes: null };
    });

    await dispatchTelegramUpdate(
      voiceUpdate(),
      deps(completion, 'weighed 75.2 kilos, about 20 percent'),
    );

    // First reply is the "transcribing…" ack, second is the result summary.
    expect(sent).toHaveLength(2);
    expect(sent[0]!.text).toMatch(/transcribing/i);
    expect(sent[1]!.text).toMatch(/Logged body measurement/);
    expect(sent[1]!.text).toMatch(/75.2 kilos/); // transcript echoed

    const { rows } = await query<{ weight_kg: string }>(
      'SELECT weight_kg FROM public.body_metrics WHERE date = $1',
      [DATE],
    );
    expect(Number(rows[0]!.weight_kg)).toBe(75.2);
  });

  it('replies with an error message when transcription fails', async () => {
    const completion = new FakeCompletionClient(() => ({}));
    const badDeps: TelegramDeps = {
      ...deps(completion),
      downloadVoice: async () => {
        throw new Error('file gone');
      },
    };
    await dispatchTelegramUpdate(voiceUpdate(), badDeps);
    expect(sent[sent.length - 1]!.text).toMatch(/Couldn't process.*file gone/);
  });
});
