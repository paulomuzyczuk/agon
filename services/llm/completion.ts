import type { z } from 'zod';
import type { PromptTemplate } from './prompts/types';
import { AnthropicCompletionClient } from './adapters/anthropicCompletion';
import { ClaudeCliCompletionClient } from './adapters/claudeCliCompletion';
import { OllamaCompletionClient } from './adapters/ollamaCompletion';

// The structured-completion boundary (CLAUDE.md "Model Portability — No LLM
// Lock-In", rule 2). A single provider-abstraction interface: callers hand it a
// versioned prompt template, an input string, and OUR OWN zod schema; the client
// returns a value validated against that schema. Validation happens HERE, not via
// any provider's structured-output feature — so swapping providers can never
// change the shape we accept. Swapping is: set env + (if new provider) add one
// adapter file behind this interface. Never a refactor.

export interface StructuredCompletionRequest<
  S extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /** The versioned prompt template (system + user framing). */
  prompt: PromptTemplate;
  /** The user content to parse — a voice-note transcript. */
  input: string;
  /** OUR schema; the returned value is `schema.parse`d before it reaches you. */
  schema: S;
}

export interface LlmCompletionClient {
  complete<S extends z.ZodTypeAny>(
    req: StructuredCompletionRequest<S>,
  ): Promise<z.output<S>>;
}

export interface CompletionClientConfig {
  provider: string;
  model: string;
  /** Required by the hosted `anthropic` provider; `claude-cli` needs none. */
  apiKey?: string;
  /** Optional override, e.g. an AI-gateway or self-hosted base URL. */
  baseUrl?: string;
  /** `claude` executable for the claude-cli provider (default 'claude'). */
  claudeBin?: string;
}

/**
 * Read the completion config from env. Only provider + model are required — the
 * API key is optional because the `claude-cli` provider runs on the machine's
 * Claude subscription and needs none; the hosted `anthropic` adapter enforces its
 * own key requirement at construction.
 */
export function completionConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): CompletionClientConfig {
  const provider = env.AGON_LLM_PROVIDER;
  const model = env.AGON_LLM_MODEL;
  if (!provider || !model) {
    throw new Error(
      'llm completion: AGON_LLM_PROVIDER and AGON_LLM_MODEL must be set',
    );
  }
  return {
    provider,
    model,
    apiKey: env.AGON_LLM_API_KEY || undefined,
    baseUrl: env.AGON_LLM_BASE_URL || undefined,
    claudeBin: env.AGON_LLM_CLAUDE_BIN || undefined,
  };
}

/**
 * The configured completion client. `claude-cli` (subscription, no API credits)
 * and `anthropic` (hosted API) ship today; adding a provider is one `case` + one
 * adapter file. Tests never call this — they inject a FakeCompletionClient.
 */
export function getCompletionClient(
  config: CompletionClientConfig = completionConfigFromEnv(),
): LlmCompletionClient {
  switch (config.provider) {
    case 'claude-cli':
      return new ClaudeCliCompletionClient(config);
    case 'anthropic':
      return new AnthropicCompletionClient(config);
    case 'ollama':
      return new OllamaCompletionClient(config);
    default:
      throw new Error(
        `llm completion: unsupported AGON_LLM_PROVIDER '${config.provider}' ` +
          `(add an adapter in services/llm/adapters/ and a case here)`,
      );
  }
}
