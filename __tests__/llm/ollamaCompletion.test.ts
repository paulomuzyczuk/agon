import { z } from 'zod';
import { OllamaCompletionClient } from '@/services/llm/adapters/ollamaCompletion';
import type { PromptTemplate } from '@/services/llm/prompts/types';

// Ollama adapter with `fetch` stubbed — asserts request shaping (native /api/chat,
// format:json, temperature 0), and that the reply is validated against the
// CALLER's schema (not any provider structured-output feature). No network.

const prompt: PromptTemplate = {
  id: 'test',
  version: 'v1',
  system: 'You extract JSON.',
  buildUser: (input: string) => `Parse: ${input}`,
};

const schema = z.object({ distanceKm: z.number(), effort: z.string() });

function mockFetch(status: number, body: unknown) {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

afterEach(() => jest.restoreAllMocks());

describe('OllamaCompletionClient', () => {
  it('POSTs /api/chat with json format + temperature 0 and validates the reply', async () => {
    const fetchMock = mockFetch(200, {
      message: {
        role: 'assistant',
        content: '{"distanceKm": 10, "effort": "easy"}',
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new OllamaCompletionClient({
      provider: 'ollama',
      model: 'qwen2.5:7b',
      baseUrl: 'http://localhost:11434',
    });
    const out = await client.complete({
      prompt,
      input: 'ran 10k easy',
      schema,
    });

    expect(out).toEqual({ distanceKm: 10, effort: 'easy' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:11434/api/chat');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.model).toBe('qwen2.5:7b');
    expect(sent.stream).toBe(false);
    expect(sent.format).toBe('json');
    expect(sent.options.temperature).toBe(0);
    expect(sent.messages[0]).toEqual({
      role: 'system',
      content: 'You extract JSON.',
    });
    expect(sent.messages[1].content).toContain('ran 10k easy');
  });

  it('handles a fenced JSON reply (extractJson tolerates it)', async () => {
    global.fetch = mockFetch(200, {
      message: { content: '```json\n{"distanceKm": 5, "effort": "hard"}\n```' },
    }) as unknown as typeof fetch;
    const client = new OllamaCompletionClient({
      provider: 'ollama',
      model: 'm',
    });
    expect(await client.complete({ prompt, input: 'x', schema })).toEqual({
      distanceKm: 5,
      effort: 'hard',
    });
  });

  it('defaults the base URL to localhost:11434', async () => {
    const fetchMock = mockFetch(200, {
      message: { content: '{"distanceKm":1,"effort":"e"}' },
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await new OllamaCompletionClient({
      provider: 'ollama',
      model: 'm',
    }).complete({
      prompt,
      input: 'x',
      schema,
    });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:11434/api/chat');
  });

  it('throws a helpful error on a non-2xx response', async () => {
    global.fetch = mockFetch(404, {
      error: 'model not found',
    }) as unknown as typeof fetch;
    const client = new OllamaCompletionClient({
      provider: 'ollama',
      model: 'missing',
    });
    await expect(
      client.complete({ prompt, input: 'x', schema }),
    ).rejects.toThrow(/is Ollama running/);
  });
});
