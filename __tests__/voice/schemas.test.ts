import {
  liftingParseSchema,
  runParseSchema,
  bodyParseSchema,
  isCaptureType,
} from '@/services/voice/schemas';

describe('isCaptureType', () => {
  it('accepts the three kinds and rejects others', () => {
    expect(isCaptureType('lift')).toBe(true);
    expect(isCaptureType('run')).toBe(true);
    expect(isCaptureType('body')).toBe(true);
    expect(isCaptureType('swim')).toBe(false);
  });
});

describe('liftingParseSchema', () => {
  it('parses a full nested session and defaults set flags', () => {
    const out = liftingParseSchema.parse({
      date: '2026-08-01',
      session_type: 'A',
      duration_min: 62,
      perceived_effort: 8,
      notes: 'felt strong',
      exercises: [
        {
          exercise: 'Back Squat',
          sets: [
            { reps: 5, weight_kg: 100, rpe: 8, rest_s: 180 },
            { reps: 5, weight_kg: 100, is_failure: true },
          ],
        },
      ],
    });
    expect(out.exercises[0]!.sets[0]!.is_warmup).toBe(false);
    expect(out.exercises[0]!.sets[1]!.is_failure).toBe(true);
    expect(out.exercises[0]!.notes).toBeNull();
  });

  it('coerces an out-of-range effort to null instead of throwing', () => {
    const out = liftingParseSchema.parse({
      session_type: 'B',
      perceived_effort: 11,
      exercises: [],
    });
    expect(out.perceived_effort).toBeNull();
    expect(out.exercises).toEqual([]);
  });

  it('requires a session_type', () => {
    expect(() => liftingParseSchema.parse({ exercises: [] })).toThrow();
  });
});

describe('runParseSchema', () => {
  it('parses fueling and pain, defaulting empty collections', () => {
    const out = runParseSchema.parse({
      distance_km: 12.5,
      perceived_effort: 6,
      shoe_used: 'Vaporfly',
      fueling: [{ product: 'Powerade', quantity: 0.5, timing_km: 6 }],
      pain_or_discomfort: { location: 'right knee', onset_km: 9 },
      general_notes: 'humid',
    });
    expect(out.fueling).toHaveLength(1);
    expect(out.pain_or_discomfort?.severity).toBeNull();
  });

  it('normalises a spoken fueling unit and nulls an unknown one', () => {
    const out = runParseSchema.parse({
      fueling: [
        { product: 'Water', amount: 1.8, unit: 'Liters' },
        { product: 'Honey', amount: 120, unit: 'grams' },
        { product: 'Gu Gel', amount: 2, unit: 'sachets' },
      ],
    });
    expect(out.fueling.map((f) => f.unit)).toEqual(['l', 'g', null]);
    expect(out.fueling[0]!.quantity).toBeNull();
  });

  it('defaults fueling to [] and pain to null when omitted', () => {
    const out = runParseSchema.parse({ distance_km: 5 });
    expect(out.fueling).toEqual([]);
    expect(out.pain_or_discomfort).toBeNull();
    expect(out.perceived_effort).toBeNull();
  });

  it('rejects a non-positive distance', () => {
    expect(() => runParseSchema.parse({ distance_km: 0 })).toThrow();
  });
});

describe('bodyParseSchema', () => {
  it('parses weight and body fat', () => {
    const out = bodyParseSchema.parse({ weight_kg: 75.8, body_fat_pct: 20.5 });
    expect(out.weight_kg).toBe(75.8);
    expect(out.body_fat_pct).toBe(20.5);
    expect(out.notes).toBeNull();
  });

  it('coerces an impossible body fat to null', () => {
    const out = bodyParseSchema.parse({ body_fat_pct: 150 });
    expect(out.body_fat_pct).toBeNull();
  });
});
