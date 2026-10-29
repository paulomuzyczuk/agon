import { logger } from '../logger';
import type { LlmCompletionClient } from '../llm/completion';
import type { TranscriptionClient } from '../llm/transcription';
import { ingestVoiceAudio, type VoiceAudioResult } from '../voice';
import { handleCommandText, contextFor } from './handlers';
import type { TelegramFile, TelegramUpdate } from './api';

// One handler for an incoming Telegram update, shared by the local poll listener
// and the production webhook. Text → command handler; voice note → download →
// transcribe → auto-classify → ingest. The LLM/transcription clients are built
// lazily (getters) so text commands keep working with no LLM key or Whisper set
// up — the heavy dependencies are only touched when a voice note actually arrives.

export interface TelegramDeps {
  sendMessage: (chatId: number, text: string) => Promise<void>;
  downloadVoice: (fileId: string) => Promise<TelegramFile>;
  getCompletion: () => LlmCompletionClient;
  getTranscription: () => TranscriptionClient;
  /** Override the capture date (athlete-local today by default). For tests. */
  today?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Human summary of a voice-note ingest, for the reply. */
export function summarizeVoiceResult(r: VoiceAudioResult): string {
  const heard = `\n📝 “${r.transcript}”`;
  if (r.lifting) {
    return `🏋️ Logged lift — ${r.lifting.exerciseCount} exercises, ${r.lifting.setCount} sets.${heard}`;
  }
  if (r.run) {
    const extra = r.run.runCreated ? ' (new run created)' : '';
    const unmatched =
      r.run.unmatchedProducts.length > 0
        ? `\n⚠️ Not in catalog: ${r.run.unmatchedProducts.join(', ')}`
        : '';
    const unconvertible =
      r.run.unconvertibleAmounts.length > 0
        ? `\n⚠️ Couldn't convert to servings: ${r.run.unconvertibleAmounts.join(', ')}`
        : '';
    return `🏃 Logged run note${extra} — ${r.run.fuelingItemsInserted} fueling item(s).${unmatched}${unconvertible}${heard}`;
  }
  if (r.body) {
    if (!r.body.bodyMetricId) {
      return `🎙️ Noted, but no weight or body-fat to log.${heard}`;
    }
    return `⚖️ Logged body measurement.${heard}`;
  }
  return `🎙️ Logged.${heard}`;
}

export async function dispatchTelegramUpdate(
  update: TelegramUpdate,
  deps: TelegramDeps,
): Promise<void> {
  const message = update.message;
  if (!message) return;
  const chatId = message.chat.id;
  const ctx = contextFor(chatId, deps.today);

  if (message.text) {
    const reply = await handleCommandText(message.text, ctx);
    await deps.sendMessage(chatId, reply);
    return;
  }

  if (message.voice) {
    await deps.sendMessage(chatId, '🎙️ Got it — transcribing your voice note…');
    try {
      const file = await deps.downloadVoice(message.voice.file_id);
      const result = await ingestVoiceAudio(
        deps.getTranscription(),
        deps.getCompletion(),
        {
          audio: file.bytes,
          filename: file.filename,
          mimeType: file.mimeType,
          capturedDate: deps.today,
        },
      );
      await deps.sendMessage(chatId, summarizeVoiceResult(result));
    } catch (err) {
      logger.error(
        'telegram voice note failed',
        { job: 'telegram-voice' },
        err,
      );
      await deps.sendMessage(
        chatId,
        `⚠️ Couldn't process that voice note: ${errorMessage(err)}`,
      );
    }
    return;
  }
  // Other message types (photos, stickers, …) are ignored.
}
