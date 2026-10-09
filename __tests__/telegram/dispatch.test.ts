import { summarizeVoiceResult } from '@/services/telegram/dispatch';
import type { VoiceAudioResult } from '@/services/voice';

// Pure formatting of the voice-note reply. The DB routing in dispatchTelegramUpdate
// is covered in the integration lane; this just pins the human-facing summaries.

function base(): VoiceAudioResult {
  return {
    captureType: 'body',
    qualitativeLogId: 'q1',
    effectiveDate: '2026-08-01',
    transcript: 'weighed 75 kilos',
    classified: true,
  };
}

describe('summarizeVoiceResult', () => {
  it('summarizes a lift and echoes the transcript', () => {
    const out = summarizeVoiceResult({
      ...base(),
      captureType: 'lift',
      lifting: { sessionId: 's1', exerciseCount: 3, setCount: 9 },
    });
    expect(out).toMatch(/🏋️ Logged lift — 3 exercises, 9 sets/);
    expect(out).toMatch(/weighed 75 kilos/);
  });

  it('flags a fueling amount that could not be converted to servings', () => {
    const out = summarizeVoiceResult({
      ...base(),
      captureType: 'run',
      run: {
        runId: 'r1',
        runCreated: false,
        fuelingItemsInserted: 0,
        fuelingItemIds: [],
        unmatchedProducts: [],
        unconvertibleAmounts: ['Salt Cap (5 g)'],
      },
    });
    expect(out).toMatch(/Couldn't convert to servings: Salt Cap \(5 g\)/);
  });

  it('flags unmatched fueling products on a run', () => {
    const out = summarizeVoiceResult({
      ...base(),
      captureType: 'run',
      run: {
        runId: 'r1',
        runCreated: true,
        fuelingItemsInserted: 1,
        fuelingItemIds: ['f1'],
        unmatchedProducts: ['MysteryGel'],
        unconvertibleAmounts: [],
      },
    });
    expect(out).toMatch(/new run created/);
    expect(out).toMatch(/Not in catalog: MysteryGel/);
  });

  it('notes when a body note had nothing to log', () => {
    const out = summarizeVoiceResult({
      ...base(),
      body: { bodyMetricId: null },
    });
    expect(out).toMatch(/no weight or body-fat to log/);
  });
});
