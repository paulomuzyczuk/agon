import { z } from 'zod';
import type {
  CompletionClientConfig,
  LlmCompletionClient,
  StructuredCompletionRequest,
} from '../completion';
import { extractJson } from '../json';

// Local, free, open-source completion via Ollama (CLAUDE.md Model Portability +
// the self-hosted Linux tower). Talks Ollama's native /api/chat with `fetch` — no
// SDK, no API key (it's a local server). A 7–8B model (Qwen2.5 7B, Llama 3.1 8B)
// runs comfortably on an 8 GB GPU and is plenty for transcript → structured JSON
// parsing. As with every adapter here, structured output is NOT trusted from the
// provider: we nudge JSON with `format: "json"` + temperature 0, then validate
// against the CALLER's zod schema — swapping providers can't change the shape.

const DEFAULT_BASE_URL = 'http://localhost:11434';

// Minimal slice of Ollama's /api/chat (non-streaming) response.
const chatResponseSchema = z.object({
  message: z.object({ content: z.string() }),
});

export class OllamaCompletionClient implements LlmCompletionClient {
  constructor(private readonly config: CompletionClientConfig) {}

  async complete<S extends z.ZodTypeAny>(
    req: StructuredCompletionRequest<S>,
  ): Promise<z.output<S>> {
    const base = (this.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        stream: false,
        format: 'json', // nudge JSON-only; we still validate with our schema
        options: { temperature: 0 }, // deterministic parsing
        messages: [
          { role: 'system', content: req.prompt.system },
          { role: 'user', content: req.prompt.buildUser(req.input) },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `ollama completion: request failed (${res.status} ${res.statusText}) ${text} ` +
          `— is Ollama running at ${base} and the model '${this.config.model}' pulled?`,
      );
    }

    const parsed = chatResponseSchema.parse(await res.json());
    if (!parsed.message.content.trim()) {
      throw new Error('ollama completion: response had empty content');
    }
    // Isolate the JSON, then validate against the CALLER's schema.
    return req.schema.parse(extractJson(parsed.message.content));
  }
}
