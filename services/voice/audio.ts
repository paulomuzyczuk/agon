import type { LlmCompletionClient } from '../llm/completion';
import type { TranscriptionClient } from '../llm/transcription';
import { ingestVoiceNote, type VoiceIngestResult } from './ingest';
import { classifyCaptureType } from './classify';
import type { CaptureType } from './schemas';

// End-to-end voice path: audio bytes → transcript → parse → fan-out. This is the
// glue the Telegram/n8n voice branch calls — transcribe with the injected
// TranscriptionClient (local mlx-whisper by default), then hand the transcript to
// ingestVoiceNote. Both clients are injected so the whole loop is testable with
// fakes (no Python, no model, no network, no keys).

export interface VoiceAudioInput {
  /** Capture kind. Omit to auto-classify the transcript (lift/run/body). */
  captureType?: CaptureType;
  /** Raw audio bytes (e.g. the .ogg downloaded from Telegram). */
  audio: Uint8Array;
  filename: string;
  mimeType: string;
  /** ISO-639-1 language hint (e.g. 'pt'), optional. */
  language?: string;
  /** Date the note was captured, YYYY-MM-DD; defaults to athlete-local today. */
  capturedDate?: string;
}

export interface VoiceAudioResult extends VoiceIngestResult {
  /** The transcript the model produced — persisted on the qualitative_logs row. */
  transcript: string;
  /** Whether the capture type was inferred (vs. supplied by the caller). */
  classified: boolean;
}

export async function ingestVoiceAudio(
  transcription: TranscriptionClient,
  completion: LlmCompletionClient,
  input: VoiceAudioInput,
): Promise<VoiceAudioResult> {
  const { text } = await transcription.transcribe({
    audio: input.audio,
    filename: input.filename,
    mimeType: input.mimeType,
    language: input.language,
  });
  const classified = input.captureType === undefined;
  const captureType =
    input.captureType ?? (await classifyCaptureType(completion, text));
  const result = await ingestVoiceNote(completion, {
    captureType,
    transcript: text,
    capturedDate: input.capturedDate,
  });
  return { ...result, transcript: text, classified };
}
