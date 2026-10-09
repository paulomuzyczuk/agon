import { fakeCompletionReturning } from '@/services/llm/fakes';
import { classifyCaptureType } from '@/services/voice/classify';

// Auto-classification with a fake model — no network. Proves the transcript is
// routed to the right capture kind and that the enum boundary is enforced.

describe('classifyCaptureType', () => {
  it('returns the classified capture type', async () => {
    const client = fakeCompletionReturning({ capture_type: 'run' });
    expect(await classifyCaptureType(client, 'ran ten k this morning')).toBe(
      'run',
    );
  });

  it('passes the classify-capture prompt to the model', async () => {
    const client = fakeCompletionReturning({ capture_type: 'lift' });
    await classifyCaptureType(client, 'squats and bench');
    expect(client.calls[0]!.prompt.id).toBe('classify-capture');
  });

  it('rejects a capture type outside the enum', async () => {
    const client = fakeCompletionReturning({ capture_type: 'swim' });
    await expect(classifyCaptureType(client, 'swam 2k')).rejects.toThrow();
  });
});
