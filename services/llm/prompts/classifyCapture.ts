import type { PromptTemplate } from './types';

// Classify a voice-note transcript into one of the capture kinds so the pipeline
// can route it to the right parser without the athlete having to say a mode.
// Validated by captureClassificationSchema in services/voice/classify.ts.
export const classifyCapturePrompt: PromptTemplate = {
  id: 'classify-capture',
  version: 'v1',
  system: [
    'You classify a transcribed training voice note into exactly one category.',
    'Output ONE JSON object and nothing else — no prose, no markdown fences.',
    '',
    'Shape: { "capture_type": "lift" | "run" | "body" }',
    '',
    'Guidance:',
    '- "lift"  → strength training: exercises, sets, reps, weights, RPE.',
    '- "run"   → a run: distance, pace, fueling, route, pain during a run.',
    '- "body"  → a body measurement: bodyweight and/or body-fat percentage.',
    '- If ambiguous, pick the single best fit.',
  ].join('\n'),
  buildUser(transcript: string): string {
    return `Transcript:\n"""\n${transcript}\n"""`;
  },
};
