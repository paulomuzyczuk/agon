import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import {
  executeCommand,
  handleCommandText,
  type CommandContext,
} from '@/services/telegram';
import { parseCommand } from '@/services/telegram/commands';

// Integration lane — the command handlers' DB writes against a live Postgres.
// Pure parsing/validation is covered in the unit lane; here we prove the effects.

const DATE = '2026-08-22';
const ctx: CommandContext = { today: DATE };

beforeAll(() => loadEnv());
afterEach(async () => {
  await query('DELETE FROM public.runs WHERE date = $1', [DATE]);
  await query('DELETE FROM public.lifting_sessions WHERE date = $1', [DATE]);
  await query('DELETE FROM public.body_metrics WHERE date = $1', [DATE]);
  await query('DELETE FROM public.sweat_observations WHERE date = $1', [DATE]);
  await query('DELETE FROM public.capture_events');
});
afterAll(() => closeDbPool());

describe('/weight and /bf', () => {
  it('logs weight', async () => {
    const reply = await executeCommand(parseCommand('/weight 76.2'), ctx);
    expect(reply).toMatch(/Logged weight 76.2 kg/);
    const { rows } = await query<{ weight_kg: string }>(
      'SELECT weight_kg FROM public.body_metrics WHERE date = $1',
      [DATE],
    );
    expect(Number(rows[0]!.weight_kg)).toBe(76.2);
  });

  it('logs body fat', async () => {
    await executeCommand(parseCommand('/bf 20.8'), ctx);
    const { rows } = await query<{ body_fat_pct: string }>(
      'SELECT body_fat_pct FROM public.body_metrics WHERE date = $1',
      [DATE],
    );
    expect(Number(rows[0]!.body_fat_pct)).toBe(20.8);
  });
});

describe('/sweat', () => {
  it('derives and stores a rate when a run exists on the date', async () => {
    await query(
      `INSERT INTO public.runs (date, distance_km, duration_s, source)
       VALUES ($1, 12, 3600, 'strava')`,
      [DATE],
    );
    const reply = await executeCommand(
      parseCommand('/sweat 76.4 75.8 0.5'),
      ctx,
    );
    expect(reply).toMatch(/New sweat rate: 1.1 L\/h/);
    const { rows } = await query<{ sweat_rate_l_per_h: string }>(
      'SELECT sweat_rate_l_per_h FROM public.sweat_observations WHERE date = $1',
      [DATE],
    );
    expect(Number(rows[0]!.sweat_rate_l_per_h)).toBe(1.1);
  });

  it('stores the observation with no rate when there is no run', async () => {
    const reply = await executeCommand(
      parseCommand('/sweat 76.4 75.8 0.5'),
      ctx,
    );
    expect(reply).toMatch(/No run found/);
    const { rows } = await query<{ sweat_rate_l_per_h: string | null }>(
      'SELECT sweat_rate_l_per_h FROM public.sweat_observations WHERE date = $1',
      [DATE],
    );
    expect(rows[0]!.sweat_rate_l_per_h).toBeNull();
  });
});

describe('/week', () => {
  it('summarizes the current block/week with counts', async () => {
    // The handler counts REAL rows in the program week containing DATE, and this
    // lane runs against the shared dev database, which holds the athlete's actual
    // training. Asserting absolute counts made the test fail the moment a run was
    // ingested into that week; assert the DELTA our own inserts cause instead.
    const before = await executeCommand(parseCommand('/week'), ctx);
    const counts = /Runs: (\d+) · Lifts: (\d+)/.exec(before);
    expect(counts).not.toBeNull();
    const runs = Number(counts![1]);
    const lifts = Number(counts![2]);

    await query(
      `INSERT INTO public.runs (date, distance_km, duration_s, source)
       VALUES ($1, 10, 3000, 'strava')`,
      [DATE],
    );
    await query(
      `INSERT INTO public.lifting_sessions (date, session_type) VALUES ($1, 'A')`,
      [DATE],
    );
    const reply = await executeCommand(parseCommand('/week'), ctx);
    expect(reply).toMatch(/Block \d · Week \d/);
    expect(reply).toContain(`Runs: ${runs + 1} · Lifts: ${lifts + 1}`);
  });
});

describe('/undo', () => {
  it('reverses the last logged entry', async () => {
    await executeCommand(parseCommand('/weight 80'), ctx);
    // sanity: it's there
    const before = await query(
      'SELECT 1 FROM public.body_metrics WHERE date = $1',
      [DATE],
    );
    expect(before.rows).toHaveLength(1);

    const reply = await executeCommand(parseCommand('/undo'), ctx);
    expect(reply).toMatch(/Undone: weight 80 kg/);

    const after = await query(
      'SELECT 1 FROM public.body_metrics WHERE date = $1',
      [DATE],
    );
    expect(after.rows).toHaveLength(0);
  });

  it('undoes the most recent of several entries, leaving the rest', async () => {
    await executeCommand(parseCommand('/weight 75'), ctx);
    await executeCommand(parseCommand('/bf 20'), ctx); // most recent
    await executeCommand(parseCommand('/undo'), ctx);

    const { rows } = await query<{
      weight_kg: string | null;
      body_fat_pct: string | null;
    }>(
      'SELECT weight_kg, body_fat_pct FROM public.body_metrics WHERE date = $1',
      [DATE],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.weight_kg).not.toBeNull(); // the weight survives
    expect(rows[0]!.body_fat_pct).toBeNull();
  });

  it('reports when there is nothing to undo', async () => {
    const reply = await executeCommand(parseCommand('/undo'), ctx);
    expect(reply).toMatch(/Nothing to undo/);
  });
});

describe('/sync and error handling', () => {
  it('runs the injected run sync and reports the new run count', async () => {
    const reply = await executeCommand(parseCommand('/sync'), {
      ...ctx,
      syncRuns: async () => ({
        pagesFetched: 1,
        sessionsSeen: 1,
        runsInserted: 1,
        runsUpdated: 0,
        skippedNonRun: 0,
        runsDeduped: 0,
        runsSkippedExisting: 0,
        streamsFetched: 1,
        hrStreamsFetched: 1,
        rateLimited: false,
        since: null,
      }),
    });
    expect(reply).toBe('🔄 Pulled 1 new run.');
  });

  it('turns a bad command into a friendly reply, not a throw', async () => {
    const reply = await handleCommandText('/weight heavy', ctx);
    expect(reply).toMatch(/⚠️.*must be a number/);
  });
});

describe('/maintained', () => {
  const TEST_BIKE_ID = 'local:test-bike-9001';

  beforeEach(async () => {
    await query(
      `INSERT INTO public.gear (gear_id, name, source, category, retired)
       VALUES ($1, 'Test Bike', 'local', 'bike', false)`,
      [TEST_BIKE_ID],
    );
  });
  afterEach(async () => {
    await query('DELETE FROM public.gear_maintenance_log WHERE gear_id = $1', [
      TEST_BIKE_ID,
    ]);
    await query('DELETE FROM public.gear WHERE gear_id = $1', [TEST_BIKE_ID]);
  });

  it('logs a completed service against the one active bike', async () => {
    const reply = await executeCommand(
      parseCommand('/maintained chain-lube'),
      ctx,
    );
    expect(reply).toMatch(/Logged Chain lube for Test Bike at 0 km/);
    const { rows } = await query<{ task_key: string; km_at_service: string }>(
      `SELECT task_key, km_at_service FROM public.gear_maintenance_log
        WHERE gear_id = $1`,
      [TEST_BIKE_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.task_key).toBe('chain-lube');
  });

  it('rejects an unknown task with the known-task list', async () => {
    const reply = await executeCommand(
      parseCommand('/maintained tire-pressure'),
      ctx,
    );
    expect(reply).toMatch(/Unknown task "tire-pressure"/);
    expect(reply).toMatch(/chain-lube/);
  });

  it('is reversible via /undo', async () => {
    await executeCommand(parseCommand('/maintained chain-lube'), ctx);
    const reply = await executeCommand(parseCommand('/undo'), ctx);
    expect(reply).toMatch(/Undone: Chain lube on Test Bike/);
    const { rows } = await query(
      'SELECT 1 FROM public.gear_maintenance_log WHERE gear_id = $1',
      [TEST_BIKE_ID],
    );
    expect(rows).toHaveLength(0);
  });

  it('errors with no active bike registered', async () => {
    await query('UPDATE public.gear SET retired = true WHERE gear_id = $1', [
      TEST_BIKE_ID,
    ]);
    const reply = await executeCommand(
      parseCommand('/maintained chain-lube'),
      ctx,
    );
    expect(reply).toMatch(/No active bike found/);
  });

  describe('with a second active bike', () => {
    const SECOND_BIKE_ID = 'local:test-bike-9002';

    beforeEach(async () => {
      await query(
        `INSERT INTO public.gear (gear_id, name, source, category, retired)
         VALUES ($1, 'Second Test Bike', 'local', 'bike', false)`,
        [SECOND_BIKE_ID],
      );
    });
    afterEach(async () => {
      await query(
        'DELETE FROM public.gear_maintenance_log WHERE gear_id = $1',
        [SECOND_BIKE_ID],
      );
      await query('DELETE FROM public.gear WHERE gear_id = $1', [
        SECOND_BIKE_ID,
      ]);
    });

    it('asks which bike when none is named', async () => {
      const reply = await executeCommand(
        parseCommand('/maintained chain-lube'),
        ctx,
      );
      expect(reply).toMatch(/Which bike\?/);
      expect(reply).toMatch(/Second Test Bike/);
      const { rows } = await query(
        'SELECT 1 FROM public.gear_maintenance_log WHERE gear_id = ANY($1)',
        [[TEST_BIKE_ID, SECOND_BIKE_ID]],
      );
      expect(rows).toHaveLength(0);
    });

    it('logs against the named bike', async () => {
      const reply = await executeCommand(
        parseCommand('/maintained chain-lube on second'),
        ctx,
      );
      expect(reply).toMatch(/Logged Chain lube for Second Test Bike/);
      const { rows } = await query<{ gear_id: string }>(
        `SELECT gear_id FROM public.gear_maintenance_log
          WHERE gear_id = ANY($1)`,
        [[TEST_BIKE_ID, SECOND_BIKE_ID]],
      );
      expect(rows.map((r) => r.gear_id)).toEqual([SECOND_BIKE_ID]);
    });

    it('rejects a name that matches no active bike', async () => {
      const reply = await executeCommand(
        parseCommand('/maintained chain-lube on trek'),
        ctx,
      );
      expect(reply).toMatch(/No active bike matches "trek"/);
    });
  });
});
