import type { PromptTemplate } from './types';

// Parse a body-metrics voice note (weight / body-fat). Validated by
// bodyParseSchema in services/voice/schemas.ts. Text commands (/weight, /bf) are
// the primary body path; this covers a spoken "weighed in at 85.8 today".
export const parseBodyPrompt: PromptTemplate = {
  id: 'parse-body',
  version: 'v1',
  system: [
    'You extract body-composition data from a transcribed voice note.',
    'Output ONE JSON object and nothing else — no prose, no markdown fences.',
    '',
    'Shape:',
    '{',
    '  "date": string | null,          // YYYY-MM-DD if stated, else null',
    '  "weight_kg": number | null,     // convert lb→kg if pounds were spoken',
    '  "body_fat_pct": number | null,',
    '  "notes": string | null',
    '}',
    '',
    'Rules: use null for anything not stated; never invent numbers.',
  ].join('\n'),
  buildUser(transcript: string): string {
    return `Transcript:\n"""\n${transcript}\n"""`;
  },
};
