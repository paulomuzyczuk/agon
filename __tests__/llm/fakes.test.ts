import { z } from 'zod';
import {
  FakeCompletionClient,
  fakeCompletionReturning,
} from '@/services/llm/fakes';
import { parseBodyPrompt } from '@/services/llm/prompts';

// The fake still runs the caller's schema — proving the boundary is real, not a
// pass-through. This is the guarantee that lets the whole voice pipeline be
// unit-tested without a live model.

const schema = z.object({ weight_kg: z.number().nullable() });

describe('FakeCompletionClient', () => {
  it('validates canned JSON through the caller schema', async () => {
    const client = fakeCompletionReturning({ weight_kg: 75.8 });
    const out = await client.complete({
      prompt: parseBodyPrompt,
      input: 'weighed 75.8',
      schema,
    });
    expect(out.weight_kg).toBe(75.8);
  });

  it('rejects canned JSON that violates the schema', async () => {
    const client = fakeCompletionReturning({ weight_kg: 'heavy' });
    await expect(
      client.complete({ prompt: parseBodyPrompt, input: 'x', schema }),
    ).rejects.toThrow();
  });

  it('records the requests it received', async () => {
    const client = new FakeCompletionClient(() => ({ weight_kg: null }));
    await client.complete({ prompt: parseBodyPrompt, input: 'hi', schema });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.input).toBe('hi');
    expect(client.calls[0]!.prompt.id).toBe('parse-body');
  });
});
