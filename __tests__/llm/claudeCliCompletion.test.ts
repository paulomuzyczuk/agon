import { z } from 'zod';
import {
  ClaudeCliCompletionClient,
  type ClaudeCliRunner,
} from '@/services/llm/adapters/claudeCliCompletion';
import { parseBodyPrompt } from '@/services/llm/prompts';

// The `claude` subprocess is replaced by an injected runner, so this covers all
// the adapter logic — command inputs, envelope parsing, JSON extraction, schema
// validation, error handling — with no real `claude` process and no credits.

const schema = z.object({ weight_kg: z.number().nullable() });

function envelope(result: string, isError = false): string {
  return JSON.stringify({
    type: 'result',
    subtype: isError ? 'error' : 'success',
    is_error: isError,
    result,
  });
}

describe('ClaudeCliCompletionClient', () => {
  it('passes system + user + model to the CLI and validates the result JSON', async () => {
    let seen: { system: string; user: string; model?: string } | null = null;
    const runner: ClaudeCliRunner = async (opts) => {
      seen = { system: opts.system, user: opts.user, model: opts.model };
      return envelope('{"weight_kg": 75.2}');
    };

    const client = new ClaudeCliCompletionClient(
      { provider: 'claude-cli', model: 'sonnet' },
      runner,
    );
    const out = await client.complete({
      prompt: parseBodyPrompt,
      input: 'weighed 75.2 kilos',
      schema,
    });

    expect(out.weight_kg).toBe(75.2);
    expect(seen!.model).toBe('sonnet');
    expect(seen!.system).toBe(parseBodyPrompt.system);
    expect(seen!.user).toContain('weighed 75.2 kilos');
  });

  it('extracts JSON even when the CLI result wraps it in prose', async () => {
    const runner: ClaudeCliRunner = async () =>
      envelope('Here you go: {"weight_kg": 74} — done.');
    const client = new ClaudeCliCompletionClient(
      { provider: 'claude-cli', model: 'sonnet' },
      runner,
    );
    const out = await client.complete({
      prompt: parseBodyPrompt,
      input: 'x',
      schema,
    });
    expect(out.weight_kg).toBe(74);
  });

  it('throws when the CLI envelope reports an error', async () => {
    const runner: ClaudeCliRunner = async () => envelope('', true);
    const client = new ClaudeCliCompletionClient(
      { provider: 'claude-cli', model: 'sonnet' },
      runner,
    );
    await expect(
      client.complete({ prompt: parseBodyPrompt, input: 'x', schema }),
    ).rejects.toThrow(/completion failed/);
  });

  it('rejects a result that violates the caller schema', async () => {
    const runner: ClaudeCliRunner = async () =>
      envelope('{"weight_kg": "heavy"}');
    const client = new ClaudeCliCompletionClient(
      { provider: 'claude-cli', model: 'sonnet' },
      runner,
    );
    await expect(
      client.complete({ prompt: parseBodyPrompt, input: 'x', schema }),
    ).rejects.toThrow();
  });
});
