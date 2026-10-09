import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import {
  FakeTranscriptionClient,
  fakeCompletionReturning,
} from '@/services/llm/fakes';
import { ingestVoiceAudio } from '@/services/voice';

// Integration lane — the end-to-end audio path (audio → transcript → parse →
// fan-out) against a live DB. A FakeTranscriptionClient stands in for mlx-whisper
// (no Python/model) and a fake completion client for the parse, so the whole loop
// runs with no external services, proving the glue and the persistence together.

const DATE = '2026-08-29';

beforeAll(() => loadEnv());
afterEach(async () => {
  await query('DELETE FROM public.body_metrics WHERE date = $1', [DATE]);
  await query('DELETE FROM public.qualitative_logs WHERE date = $1', [DATE]);
  await query('DELETE FROM public.capture_events');
});
afterAll(() => closeDbPool());

describe('ingestVoiceAudio', () => {
  it('transcribes audio then fans the note out, returning the transcript', async () => {
    const transcription = new FakeTranscriptionClient(
      'weighed in at 75.4 kilos this morning, about 20 percent',
    );
    const completion = fakeCompletionReturning({
      weight_kg: 75.4,
      body_fat_pct: 20,
      notes: 'morning',
    });

    const result = await ingestVoiceAudio(transcription, completion, {
      captureType: 'body',
      audio: new Uint8Array([1, 2, 3]),
      filename: 'note.ogg',
      mimeType: 'audio/ogg',
      capturedDate: DATE,
    });

    expect(result.transcript).toMatch(/75.4 kilos/);
    expect(result.body!.bodyMetricId).not.toBeNull();

    const row = await query<{ weight_kg: string }>(
      'SELECT weight_kg FROM public.body_metrics WHERE id = $1',
      [result.body!.bodyMetricId],
    );
    expect(Number(row.rows[0]!.weight_kg)).toBe(75.4);

    // The transcript is preserved on the qualitative_logs audit row.
    const log = await query<{ raw_transcript: string }>(
      'SELECT raw_transcript FROM public.qualitative_logs WHERE id = $1',
      [result.qualitativeLogId],
    );
    expect(log.rows[0]!.raw_transcript).toMatch(/75.4 kilos/);

    // The transcription client actually received our audio bytes.
    expect(transcription.calls).toHaveLength(1);
    expect([...transcription.calls[0]!.audio]).toEqual([1, 2, 3]);
  });
});
