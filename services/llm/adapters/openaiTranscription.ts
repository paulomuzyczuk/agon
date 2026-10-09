import { z } from 'zod';
import type {
  TranscriptionClient,
  TranscriptionClientConfig,
  TranscriptionRequest,
  TranscriptionResult,
} from '../transcription';

// The one concrete transcription adapter: OpenAI's Whisper endpoint, called with
// `fetch` + the Node-global FormData/Blob (no SDK, no form-data dependency).
// Provider-neutral swap point per CLAUDE.md Model Portability.

const DEFAULT_BASE_URL = 'https://api.openai.com';

const transcriptionResponseSchema = z.object({ text: z.string() });

export class OpenAiTranscriptionClient implements TranscriptionClient {
  private readonly apiKey: string;

  constructor(private readonly config: TranscriptionClientConfig) {
    // apiKey is optional on the shared config (the local mlx adapter needs
    // none); the hosted adapter requires it, so fail loudly at construction.
    if (!config.apiKey) {
      throw new Error(
        'openai transcription: AGON_TRANSCRIPTION_API_KEY is required for the ' +
          'hosted openai provider (use provider "mlx-whisper" for local, keyless STT)',
      );
    }
    this.apiKey = config.apiKey;
  }

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const base = this.config.baseUrl ?? DEFAULT_BASE_URL;
    const form = new FormData();
    form.append('model', this.config.model);
    if (req.language) form.append('language', req.language);
    // Copy into a fresh ArrayBuffer so Blob gets a plain ArrayBuffer, not a
    // possibly-shared view (SharedArrayBuffer isn't a valid BlobPart).
    const bytes = new Uint8Array(req.audio);
    form.append(
      'file',
      new Blob([bytes], { type: req.mimeType }),
      req.filename,
    );

    const res = await fetch(`${base}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `openai transcription: request failed (${res.status} ${res.statusText}) ${text}`,
      );
    }

    return transcriptionResponseSchema.parse(await res.json());
  }
}
