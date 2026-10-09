import { z } from 'zod';

// zod schemas for the LLM's parsed output — the validation boundary between the
// model and our typed tables (CLAUDE.md "zod-validate at the boundary"). These
// describe OUR OWN shape; they are NOT a provider structured-output feature. Each
// prompt template in services/llm/prompts/ must stay in step with the matching
// schema here.

/** The three voice-note capture kinds; also the qualitative_logs.session_type. */
export const CAPTURE_TYPES = ['lift', 'run', 'body'] as const;
export type CaptureType = (typeof CAPTURE_TYPES)[number];

export function isCaptureType(v: string): v is CaptureType {
  return (CAPTURE_TYPES as readonly string[]).includes(v);
}

// A bounded score: accept a number, coerce out-of-range/garbage to null rather
// than rejecting the whole note (a mis-heard "effort 11" shouldn't drop a session).
const effort = z.number().int().min(1).max(10).nullable().catch(null);
const rpe = z.number().min(0).max(10).nullable().catch(null);

// ── lifting ───────────────────────────────────────────────────────────────────
export const liftingSetSchema = z.object({
  reps: z.number().nullable().default(null),
  weight_kg: z.number().nonnegative().nullable().default(null),
  rpe,
  rest_s: z.number().nullable().default(null),
  is_warmup: z
    .boolean()
    .nullish()
    .transform((v) => v ?? false),
  is_failure: z
    .boolean()
    .nullish()
    .transform((v) => v ?? false),
  notes: z.string().nullable().default(null),
});

export const liftingExerciseSchema = z.object({
  exercise: z.string().min(1),
  notes: z.string().nullable().default(null),
  sets: z.array(liftingSetSchema).default([]),
});

export const liftingParseSchema = z.object({
  date: z.string().nullable().default(null),
  session_type: z.string().min(1),
  duration_min: z.number().nullable().default(null),
  perceived_effort: effort,
  notes: z.string().nullable().default(null),
  exercises: z.array(liftingExerciseSchema).default([]),
});
export type LiftingParse = z.infer<typeof liftingParseSchema>;

// ── run ───────────────────────────────────────────────────────────────────────
// Spoken unit → canonical FuelingUnit; anything unrecognised becomes null (the
// amount is then treated as a count of servings by fuelingServings).
const FUELING_UNIT_ALIASES: Record<string, 'serving' | 'ml' | 'l' | 'g'> = {
  serving: 'serving',
  servings: 'serving',
  bottle: 'serving',
  bottles: 'serving',
  ml: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  millilitre: 'ml',
  millilitres: 'ml',
  l: 'l',
  liter: 'l',
  liters: 'l',
  litre: 'l',
  litres: 'l',
  g: 'g',
  gram: 'g',
  grams: 'g',
};
const fuelingUnit = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? (FUELING_UNIT_ALIASES[v.trim().toLowerCase()] ?? null)
      : null,
  z.enum(['serving', 'ml', 'l', 'g']).nullable(),
);

export const runFuelingSchema = z.object({
  product: z.string().nullable().default(null),
  // The amount as spoken + its unit (prompt v2); converted to catalog servings
  // by lib/fuelingCatalog.ts fuelingServings, never by the model.
  amount: z.number().nullable().default(null),
  unit: fuelingUnit.default(null),
  // Legacy (prompt v1): a servings count. Still read for stored parses.
  quantity: z.number().nullable().default(null),
  timing_km: z.number().nonnegative().nullable().default(null),
});

export const runParseSchema = z.object({
  date: z.string().nullable().default(null),
  distance_km: z.number().positive().nullable().default(null),
  perceived_effort: effort,
  shoe_used: z.string().nullable().default(null),
  fueling: z.array(runFuelingSchema).default([]),
  pain_or_discomfort: z
    .object({
      location: z.string().nullable().default(null),
      onset_km: z.number().nonnegative().nullable().default(null),
      severity: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  general_notes: z.string().nullable().default(null),
});
export type RunParse = z.infer<typeof runParseSchema>;

// ── body ──────────────────────────────────────────────────────────────────────
export const bodyParseSchema = z.object({
  date: z.string().nullable().default(null),
  weight_kg: z.number().positive().nullable().default(null),
  body_fat_pct: z.number().min(0).max(100).nullable().catch(null),
  notes: z.string().nullable().default(null),
});
export type BodyParse = z.infer<typeof bodyParseSchema>;
