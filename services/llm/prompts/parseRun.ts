import type { PromptTemplate } from './types';

// Parse a post-run voice note. Mirrors CLAUDE.md "Qualitative Run Log Fields".
// Validated by runParseSchema in services/voice/schemas.ts.
export const parseRunPrompt: PromptTemplate = {
  id: 'parse-run',
  version: 'v2',
  system: [
    'You extract structured running data from a transcribed post-run voice note.',
    'Output ONE JSON object and nothing else — no prose, no markdown fences.',
    '',
    'Shape:',
    '{',
    '  "date": string | null,               // YYYY-MM-DD if stated, else null',
    '  "distance_km": number | null,',
    '  "perceived_effort": integer | null,  // whole 1–10',
    '  "shoe_used": string | null,',
    '  "fueling": [                          // each thing consumed during the run',
    '    {',
    '      "product": string | null,        // e.g. "Powerade", "Gu gel", "water"',
    '      "amount": number | null,         // the amount EXACTLY as spoken — 120 for "120 g of honey", 1.8 for "1.8 liters", 2 for "two bottles", 0.5 for "half a Powerade"; null if unstated. Never convert units yourself.',
    '      "unit": "serving" | "ml" | "l" | "g" | null,  // unit of amount; "serving" for counted things (bottles, gels, sachets, capsules, tablespoons, bananas)',
    '      "timing_km": number | null        // km mark where it was taken, if stated',
    '    }',
    '  ],',
    '  "pain_or_discomfort": {',
    '    "location": string | null,',
    '    "onset_km": number | null,',
    '    "severity": string | null          // e.g. "mild", "sharp"; free text',
    '  } | null,',
    '  "general_notes": string | null',
    '}',
    '',
    'Rules:',
    '- Use null for anything not stated; never invent values.',
    '- "fueling" is [] if nothing was consumed.',
    '- The athlete\'s homemade drink (honey + kitchen salt dissolved in water — "the solution", "the mix", "standard fueling solution") is product "Standard Fueling Solution". Use it only when they refer to that prepared drink; an ingredient mentioned on its own ("120 grams of honey", "1.8 liters of water") stays that ingredient.',
    '- "pain_or_discomfort" is null if the athlete reports none.',
  ].join('\n'),
  buildUser(transcript: string): string {
    return `Transcript:\n"""\n${transcript}\n"""`;
  },
};
