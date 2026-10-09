import type { PromptTemplate } from './types';

// Parse a post-lift voice note into the nested lifting shape (session → exercises
// → sets). The schema that validates the output lives in services/voice/schemas.ts
// (liftingParseSchema); this template only describes the contract in prose so the
// two must be kept in step. Provider-neutral: no model name, no SDK.
export const parseLiftingPrompt: PromptTemplate = {
  id: 'parse-lifting',
  version: 'v1',
  system: [
    'You extract structured strength-training data from a transcribed voice note.',
    'Output ONE JSON object and nothing else — no prose, no markdown fences.',
    '',
    'Shape:',
    '{',
    '  "date": string | null,               // YYYY-MM-DD if the athlete states it, else null',
    '  "session_type": string,              // e.g. "A", "B", "C", "Push", "Pull", "Legs"; "unknown" if unclear',
    '  "duration_min": integer | null,',
    '  "perceived_effort": integer | null,  // whole 1–10 for the whole session',
    '  "notes": string | null,',
    '  "exercises": [',
    '    {',
    '      "exercise": string,              // canonical name, e.g. "Back Squat"',
    '      "notes": string | null,',
    '      "sets": [',
    '        {',
    '          "reps": integer | null,',
    '          "weight_kg": number | null,  // convert lb→kg if the athlete used pounds',
    '          "rpe": number | null,        // 0–10, halves allowed',
    '          "rest_s": integer | null,',
    '          "is_warmup": boolean,        // default false',
    '          "is_failure": boolean,       // default false',
    '          "notes": string | null',
    '        }',
    '      ]',
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- Use null for anything not stated; never invent numbers.',
    '- Expand shorthand like "3x8 at 80" into three set objects of 8 reps @ 80 kg.',
    '- Preserve exercise order as spoken.',
    '- If no exercises are described, return "exercises": [].',
  ].join('\n'),
  buildUser(transcript: string): string {
    return `Transcript:\n"""\n${transcript}\n"""`;
  },
};
