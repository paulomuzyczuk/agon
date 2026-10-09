import { OpenAiTranscriptionClient } from './adapters/openaiTranscription';
import { MlxWhisperTranscriptionClient } from './adapters/mlxWhisperTranscription';
import { WhisperCppTranscriptionClient } from './adapters/whisperCppTranscription';

// The audio→text boundary for the voice-note pipeline (CLAUDE.md architecture:
// "Transcribe via Whisper"). Same portability rule as completion: provider +
// model come from env, one adapter file per provider behind this interface, and
// swapping is config not refactor. Kept separate from completion so a deployment
// can mix providers (e.g. local mlx-whisper for audio, Anthropic for parsing).
//
// Two adapters ship: `mlx-whisper` (local, offline, free — Whisper via Apple's
// MLX, mirroring the pygmalion project) and `openai` (hosted Whisper). Local
// needs no API key; hosted does — hence apiKey is optional here and each adapter
// enforces what it actually requires.

export interface TranscriptionRequest {
  /** Raw audio bytes (e.g. the .ogg Telegram voice note). */
  audio: Uint8Array;
  /** Filename hint for the multipart part; drives server-side format sniffing. */
  filename: string;
  /** MIME type, e.g. 'audio/ogg'. */
  mimeType: string;
  /** ISO-639-1 language hint (e.g. 'pt'), optional. */
  language?: string;
}

export interface TranscriptionResult {
  text: string;
}

export interface TranscriptionClient {
  transcribe(req: TranscriptionRequest): Promise<TranscriptionResult>;
}

export interface TranscriptionClientConfig {
  provider: string;
  model: string;
  /** Required by hosted providers (openai); local providers (mlx) ignore it. */
  apiKey?: string;
  baseUrl?: string;
  /** Python executable for the local mlx adapter (default 'python3'). */
  pythonBin?: string;
  /** whisper.cpp CLI for the whisper-cpp adapter (default 'whisper-cli'). */
  whisperBin?: string;
  /** Override the local transcriber script path (tests / non-default layout). */
  scriptPath?: string;
}

/**
 * Read transcription config from env. Only provider + model are required —
 * the API key is optional because the local `mlx-whisper` provider needs none;
 * the hosted `openai` adapter enforces its own key requirement at construction.
 */
export function transcriptionConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): TranscriptionClientConfig {
  const provider = env.AGON_TRANSCRIPTION_PROVIDER;
  const model = env.AGON_TRANSCRIPTION_MODEL;
  if (!provider || !model) {
    throw new Error(
      'llm transcription: AGON_TRANSCRIPTION_PROVIDER and ' +
        'AGON_TRANSCRIPTION_MODEL must be set',
    );
  }
  return {
    provider,
    model,
    apiKey: env.AGON_TRANSCRIPTION_API_KEY || undefined,
    baseUrl: env.AGON_TRANSCRIPTION_BASE_URL || undefined,
    pythonBin: env.AGON_TRANSCRIPTION_PYTHON || undefined,
    whisperBin: env.AGON_TRANSCRIPTION_WHISPER_BIN || undefined,
  };
}

/**
 * The configured transcription client. `mlx-whisper` (local, offline) and
 * `openai` (hosted) ship today; adding a provider is one `case` + one adapter
 * file. Tests inject a FakeTranscriptionClient.
 */
export function getTranscriptionClient(
  config: TranscriptionClientConfig = transcriptionConfigFromEnv(),
): TranscriptionClient {
  switch (config.provider) {
    case 'mlx-whisper':
    case 'mlx':
      return new MlxWhisperTranscriptionClient(config);
    case 'whisper-cpp':
    case 'whispercpp':
      return new WhisperCppTranscriptionClient(config);
    case 'openai':
      return new OpenAiTranscriptionClient(config);
    default:
      throw new Error(
        `llm transcription: unsupported AGON_TRANSCRIPTION_PROVIDER ` +
          `'${config.provider}' (add an adapter and a case here)`,
      );
  }
}
