import {
  completionConfigFromEnv,
  getCompletionClient,
} from '@/services/llm/completion';
import {
  transcriptionConfigFromEnv,
  getTranscriptionClient,
} from '@/services/llm/transcription';
import { AnthropicCompletionClient } from '@/services/llm/adapters/anthropicCompletion';
import { ClaudeCliCompletionClient } from '@/services/llm/adapters/claudeCliCompletion';
import { OpenAiTranscriptionClient } from '@/services/llm/adapters/openaiTranscription';
import { MlxWhisperTranscriptionClient } from '@/services/llm/adapters/mlxWhisperTranscription';
import { OllamaCompletionClient } from '@/services/llm/adapters/ollamaCompletion';
import { WhisperCppTranscriptionClient } from '@/services/llm/adapters/whisperCppTranscription';

// Factory + env-config behavior. No network — we only assert construction and
// the config/provider rules that make swapping a config change.

describe('completionConfigFromEnv', () => {
  it('reads provider/model/key from env', () => {
    const cfg = completionConfigFromEnv({
      AGON_LLM_PROVIDER: 'anthropic',
      AGON_LLM_MODEL: 'claude-sonnet-5',
      AGON_LLM_API_KEY: 'k',
      AGON_LLM_BASE_URL: 'https://gw.example',
    });
    expect(cfg).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKey: 'k',
      baseUrl: 'https://gw.example',
    });
  });

  it('requires provider + model (key optional for claude-cli)', () => {
    expect(() =>
      completionConfigFromEnv({ AGON_LLM_PROVIDER: 'claude-cli' }),
    ).toThrow(/AGON_LLM_PROVIDER and AGON_LLM_MODEL/);
  });

  it('reads the claude-cli config with no API key', () => {
    const cfg = completionConfigFromEnv({
      AGON_LLM_PROVIDER: 'claude-cli',
      AGON_LLM_MODEL: 'sonnet',
      AGON_LLM_CLAUDE_BIN: 'claude',
    });
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.claudeBin).toBe('claude');
  });
});

describe('getCompletionClient', () => {
  it('builds the claude-cli adapter with no API key', () => {
    const client = getCompletionClient({
      provider: 'claude-cli',
      model: 'sonnet',
    });
    expect(client).toBeInstanceOf(ClaudeCliCompletionClient);
  });

  it('builds the anthropic adapter when a key is present', () => {
    const client = getCompletionClient({
      provider: 'anthropic',
      model: 'm',
      apiKey: 'k',
    });
    expect(client).toBeInstanceOf(AnthropicCompletionClient);
  });

  it('rejects the hosted anthropic provider when no key is present', () => {
    expect(() =>
      getCompletionClient({ provider: 'anthropic', model: 'm' }),
    ).toThrow(/AGON_LLM_API_KEY is required/);
  });

  it('builds the local ollama adapter with no API key', () => {
    const client = getCompletionClient({
      provider: 'ollama',
      model: 'qwen2.5:7b',
    });
    expect(client).toBeInstanceOf(OllamaCompletionClient);
  });

  it('throws on an unsupported provider', () => {
    expect(() =>
      getCompletionClient({ provider: 'nope', model: 'm', apiKey: 'k' }),
    ).toThrow(/unsupported AGON_LLM_PROVIDER 'nope'/);
  });
});

describe('transcription factory', () => {
  it('reads config from env and builds the openai adapter', () => {
    const cfg = transcriptionConfigFromEnv({
      AGON_TRANSCRIPTION_PROVIDER: 'openai',
      AGON_TRANSCRIPTION_MODEL: 'whisper-1',
      AGON_TRANSCRIPTION_API_KEY: 'k',
    });
    expect(getTranscriptionClient(cfg)).toBeInstanceOf(
      OpenAiTranscriptionClient,
    );
  });

  it('builds the local mlx-whisper adapter with no API key', () => {
    const cfg = transcriptionConfigFromEnv({
      AGON_TRANSCRIPTION_PROVIDER: 'mlx-whisper',
      AGON_TRANSCRIPTION_MODEL: 'mlx-community/whisper-medium-mlx',
    });
    expect(cfg.apiKey).toBeUndefined();
    expect(getTranscriptionClient(cfg)).toBeInstanceOf(
      MlxWhisperTranscriptionClient,
    );
  });

  it('builds the local whisper-cpp adapter with no API key', () => {
    const cfg = transcriptionConfigFromEnv({
      AGON_TRANSCRIPTION_PROVIDER: 'whisper-cpp',
      AGON_TRANSCRIPTION_MODEL: '/opt/whisper/models/ggml-medium.bin',
      AGON_TRANSCRIPTION_WHISPER_BIN: 'whisper-cli',
    });
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.whisperBin).toBe('whisper-cli');
    expect(getTranscriptionClient(cfg)).toBeInstanceOf(
      WhisperCppTranscriptionClient,
    );
  });

  it('only requires provider + model from env (key is optional)', () => {
    expect(() =>
      transcriptionConfigFromEnv({
        AGON_TRANSCRIPTION_PROVIDER: 'mlx-whisper',
      }),
    ).toThrow(/AGON_TRANSCRIPTION_PROVIDER and AGON_TRANSCRIPTION_MODEL/);
  });

  it('rejects the hosted openai provider when no key is present', () => {
    expect(() =>
      getTranscriptionClient({ provider: 'openai', model: 'whisper-1' }),
    ).toThrow(/AGON_TRANSCRIPTION_API_KEY is required/);
  });

  it('throws on an unsupported provider', () => {
    expect(() =>
      getTranscriptionClient({ provider: 'nope', model: 'm', apiKey: 'k' }),
    ).toThrow(/unsupported AGON_TRANSCRIPTION_PROVIDER/);
  });
});
