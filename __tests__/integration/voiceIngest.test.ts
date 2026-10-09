import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { fakeCompletionReturning } from '@/services/llm/fakes';
import { ingestVoiceNote } from '@/services/voice';
import { upsertFuelingProduct } from '@/services/fueling';

// Integration lane — the full voice path against a live local Postgres, with a
// FAKE LLM adapter returning canned JSON (no network, no keys). Proves the
// parse→persist→fan-out chain writes the typed schema and the qualitative_logs
// audit row for each capture type.

const DATE = '2026-08-15';
const TEST_PRODUCT = 'IntegPowerade';

beforeAll(async () => {
  loadEnv();
  await upsertFuelingProduct({
    name: TEST_PRODUCT,
    category: 'isotonic',
    servingDesc: '500 ml',
    waterMl: 500,
    carbsG: 19,
    sodiumMg: 225,
    potassiumMg: 55,
    magnesiumMg: 0,
    caffeineMg: 0,
    kcal: 80,
    notes: null,
  });
});

afterEach(async () => {
  // runs cascade into run_fueling_items; then the sessions/metrics/logs.
  await query('DELETE FROM public.runs WHERE date = $1', [DATE]);
  await query('DELETE FROM public.lifting_sessions WHERE date = $1', [DATE]);
  await query('DELETE FROM public.body_metrics WHERE date = $1', [DATE]);
  await query('DELETE FROM public.qualitative_logs WHERE date = $1', [DATE]);
  await query('DELETE FROM public.capture_events');
});

afterAll(async () => {
  await query('DELETE FROM public.fueling_products WHERE name = $1', [
    TEST_PRODUCT,
  ]);
  await closeDbPool();
});

describe('voice ingest — lifting', () => {
  it('fans a lift note out into session → exercises → sets + a log row', async () => {
    const client = fakeCompletionReturning({
      session_type: 'A',
      duration_min: 60,
      perceived_effort: 8,
      notes: 'solid',
      exercises: [
        {
          exercise: 'Back Squat',
          sets: [
            { reps: 5, weight_kg: 100, rpe: 8, rest_s: 180, is_warmup: false },
            { reps: 5, weight_kg: 100, rpe: 9, is_failure: true },
          ],
        },
        { exercise: 'Bench Press', sets: [{ reps: 8, weight_kg: 70 }] },
      ],
    });

    const result = await ingestVoiceNote(client, {
      captureType: 'lift',
      transcript: 'Session A, squats and bench...',
      capturedDate: DATE,
    });

    expect(result.lifting).toMatchObject({ exerciseCount: 2, setCount: 3 });

    const sets = await query<{ count: string }>(
      `SELECT count(*) AS count FROM public.lifting_sets s
         JOIN public.lifting_exercises e ON e.id = s.exercise_id
        WHERE e.session_id = $1`,
      [result.lifting!.sessionId],
    );
    expect(Number(sets.rows[0]!.count)).toBe(3);

    const log = await query<{ session_type: string }>(
      'SELECT session_type FROM public.qualitative_logs WHERE id = $1',
      [result.qualitativeLogId],
    );
    expect(log.rows[0]!.session_type).toBe('lift');
  });
});

describe('voice ingest — run', () => {
  it('enriches the existing run and resolves fueling, flagging the unmatched one', async () => {
    const runIns = await query<{ id: string }>(
      `INSERT INTO public.runs (date, distance_km, duration_s, source)
       VALUES ($1, 10, 3000, 'strava') RETURNING id`,
      [DATE],
    );
    const runId = runIns.rows[0]!.id;

    const client = fakeCompletionReturning({
      distance_km: 10,
      perceived_effort: 6,
      shoe_used: 'Vaporfly',
      fueling: [
        { product: TEST_PRODUCT, quantity: 1, timing_km: 5 },
        { product: 'MysteryGel', quantity: 1, timing_km: 8 },
      ],
      pain_or_discomfort: {
        location: 'right knee',
        onset_km: 7,
        severity: 'mild',
      },
      general_notes: 'humid morning',
    });

    const result = await ingestVoiceNote(client, {
      captureType: 'run',
      transcript: 'Ten k, powerade at 5, gel at 8, knee twinge...',
      capturedDate: DATE,
    });

    expect(result.run).toMatchObject({
      runId,
      runCreated: false,
      fuelingItemsInserted: 1,
      unmatchedProducts: ['MysteryGel'],
    });

    const run = await query<{
      perceived_effort: number;
      pain_location: string;
      pain_onset_km: string;
      shoe_used: string;
    }>(
      `SELECT perceived_effort, pain_location, pain_onset_km, shoe_used
         FROM public.runs WHERE id = $1`,
      [runId],
    );
    expect(run.rows[0]).toMatchObject({
      perceived_effort: 6,
      pain_location: 'right knee',
      shoe_used: 'Vaporfly',
    });
    expect(Number(run.rows[0]!.pain_onset_km)).toBe(7);

    const items = await query<{ count: string }>(
      'SELECT count(*) AS count FROM public.run_fueling_items WHERE run_id = $1',
      [runId],
    );
    expect(Number(items.rows[0]!.count)).toBe(1);
  });

  it('creates a manual run when none exists and a distance was spoken', async () => {
    const client = fakeCompletionReturning({
      distance_km: 8.2,
      perceived_effort: 5,
      fueling: [],
      general_notes: 'easy shakeout',
    });

    const result = await ingestVoiceNote(client, {
      captureType: 'run',
      transcript: 'Easy 8k, nothing to report',
      capturedDate: DATE,
    });

    expect(result.run!.runCreated).toBe(true);
    const run = await query<{ source: string; distance_km: string }>(
      'SELECT source, distance_km FROM public.runs WHERE id = $1',
      [result.run!.runId],
    );
    expect(run.rows[0]!.source).toBe('telegram');
    expect(Number(run.rows[0]!.distance_km)).toBe(8.2);
  });
});

describe('voice ingest — body', () => {
  it('writes a body_metrics row from a body note', async () => {
    const client = fakeCompletionReturning({
      weight_kg: 75.6,
      body_fat_pct: 20.4,
      notes: 'morning',
    });
    const result = await ingestVoiceNote(client, {
      captureType: 'body',
      transcript: 'Weighed 75.6 at 20.4 percent',
      capturedDate: DATE,
    });
    expect(result.body!.bodyMetricId).not.toBeNull();
    const row = await query<{ weight_kg: string; body_fat_pct: string }>(
      'SELECT weight_kg, body_fat_pct FROM public.body_metrics WHERE id = $1',
      [result.body!.bodyMetricId],
    );
    expect(Number(row.rows[0]!.weight_kg)).toBe(75.6);
    expect(Number(row.rows[0]!.body_fat_pct)).toBe(20.4);
  });

  it('skips the write when neither weight nor body fat is present', async () => {
    const client = fakeCompletionReturning({ notes: 'felt bloated' });
    const result = await ingestVoiceNote(client, {
      captureType: 'body',
      transcript: 'nothing measurable',
      capturedDate: DATE,
    });
    expect(result.body!.bodyMetricId).toBeNull();
    // The qualitative log is still recorded even when the fan-out is a no-op.
    const log = await query<{ count: string }>(
      'SELECT count(*) AS count FROM public.qualitative_logs WHERE id = $1',
      [result.qualitativeLogId],
    );
    expect(Number(log.rows[0]!.count)).toBe(1);
  });
});
