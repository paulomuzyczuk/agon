import { z } from 'zod';
import type {
  CompletionClientConfig,
  LlmCompletionClient,
  StructuredCompletionRequest,
} from '../completion';
import { extractJson } from '../json';

// The one concrete completion adapter (CLAUDE.md Model Portability: "at most one
// adapter file" per provider). Talks the Anthropic Messages REST API directly
// with `fetch` + zod — no provider SDK, matching how services/strava/client.ts
// and services/fitbit/oauth.ts speak to their APIs. Structured output is NOT
// requested via any provider feature: we ask for JSON in the prompt and validate
// with the caller's own schema in completion.ts's contract, fulfilled here.

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 4096;

// Minimal slice of the Messages response we read: the first text block.
const messagesResponseSchema = z.object({
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .min(1),
});

export class AnthropicCompletionClient implements LlmCompletionClient {
  private readonly apiKey: string;

  constructor(private readonly config: CompletionClientConfig) {
    // apiKey is optional on the shared config (claude-cli needs none); the hosted
    // adapter requires it, so fail loudly at construction rather than sending an
    // undefined key.
    if (!config.apiKey) {
      throw new Error(
        'anthropic completion: AGON_LLM_API_KEY is required for the hosted ' +
          'anthropic provider (use AGON_LLM_PROVIDER=claude-cli for keyless, ' +
          'subscription-based completion)',
      );
    }
    this.apiKey = config.apiKey;
  }

  async complete<S extends z.ZodTypeAny>(
    req: StructuredCompletionRequest<S>,
  ): Promise<z.output<S>> {
    const base = this.config.baseUrl ?? DEFAULT_BASE_URL;
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: MAX_TOKENS,
        system: req.prompt.system,
        messages: [{ role: 'user', content: req.prompt.buildUser(req.input) }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `anthropic completion: request failed (${res.status} ${res.statusText}) ${text}`,
      );
    }

    const parsed = messagesResponseSchema.parse(await res.json());
    const text = parsed.content.find((b) => b.type === 'text')?.text ?? '';
    if (!text) {
      throw new Error('anthropic completion: response had no text block');
    }
    // Isolate the JSON, then validate against the CALLER's schema — the boundary
    // that keeps output shape independent of the provider.
    return req.schema.parse(extractJson(text));
  }
}
