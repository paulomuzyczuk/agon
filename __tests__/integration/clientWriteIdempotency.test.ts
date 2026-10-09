import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { POST as nutritionLog } from '@/app/api/nutrition/log/route';
import { DELETE as nutritionDelete } from '@/app/api/nutrition/log/[id]/route';
import { POST as healthLog } from '@/app/api/general-health/log/route';

// Integration lane (agon_test DB — jest.integration.setup.ts). MZY-205: the
// PWA outbox may deliver the same write more than once — a flush that drops
// after the server committed but before the response arrived is retried.
// These prove every replay is a no-op at the real SQL layer, and that the
// device's capturedAt (not the server's "now") decides date + created_at.

const FOOD = 'zz-test-outbox-oats';
const TEMPLATE = 'zz-test-outbox-plan';
const MED = 'zz-test-outbox-med';
// 23:30 in Berlin on 1 Mar 2026 — already 2 Mar nowhere, but a UTC-date
// bug would still file it on 1 Mar; a server-now bug files it on today.
const CAPTURED_AT = '2026-03-01T22:30:00.000Z';

function post(handler: (r: Request) => Promise<Response>, body: object) {
  return handler(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await query<{ n: string }>(sql, params);
  return Number(rows[0]!.n);
}

async function cleanup(): Promise<void> {
  await query(
    `DELETE FROM public.meal_logs WHERE id IN (
       SELECT meal_log_id FROM public.meal_log_items mli
         JOIN public.foods f ON f.id = mli.food_id WHERE f.name = $1)`,
    [FOOD],
  );
  await query(`DELETE FROM public.meal_templates WHERE name = $1`, [TEMPLATE]);
  await query(`DELETE FROM public.foods WHERE name = $1`, [FOOD]);
  await query(
    `DELETE FROM public.medication_logs WHERE medication_id IN (
       SELECT id FROM public.medications WHERE name = $1)`,
    [MED],
  );
  await query(`DELETE FROM public.medications WHERE name = $1`, [MED]);
}

beforeAll(async () => {
  loadEnv();
  await cleanup();
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.foods (name, serving_qty, serving_unit, carbs_g, protein_g, fat_g, kcal)
     VALUES ($1, 40, 'g', 27, 5, 3, 150) RETURNING id`,
    [FOOD],
  );
  const foodId = rows[0]!.id;
  const { rows: t } = await query<{ id: string }>(
    `INSERT INTO public.meal_templates (name) VALUES ($1) RETURNING id`,
    [TEMPLATE],
  );
  for (const slot of ['breakfast', 'snack', 'dinner']) {
    await query(
      `INSERT INTO public.meal_template_items (meal_template_id, meal_slot, food_id, quantity)
       VALUES ($1, $2, $3, 1)`,
      [t[0]!.id, slot, foodId],
    );
  }
});

afterAll(async () => {
  await cleanup();
  await closeDbPool();
});

describe('POST /api/nutrition/log with a clientId', () => {
  it('an ad-hoc meal replayed 3x lands exactly once, dated by capturedAt', async () => {
    const clientId = crypto.randomUUID();
    const body = {
      mode: 'adhoc',
      mealSlot: 'dinner',
      items: [{ food: FOOD, quantity: 2 }],
      clientId,
      capturedAt: CAPTURED_AT,
    };
    for (let i = 0; i < 3; i++) {
      const res = await post(nutritionLog, body);
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ ids: [clientId] });
    }

    const { rows } = await query<{ date: string; created_at: Date }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, created_at FROM public.meal_logs WHERE id = $1`,
      [clientId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe('2026-03-01'); // Berlin-local day of the action
    expect(rows[0]!.created_at.toISOString()).toBe(CAPTURED_AT);
    expect(
      await count(
        `SELECT count(*) AS n FROM public.meal_log_items WHERE meal_log_id = $1`,
        [clientId],
      ),
    ).toBe(1); // items not duplicated by the replays either
  });

  it('a whole template (3 rows from one action) replays without duplicating any row', async () => {
    const clientId = crypto.randomUUID();
    const body = {
      mode: 'whole_template',
      date: '2026-03-02',
      templateName: TEMPLATE,
      clientId,
      capturedAt: CAPTURED_AT,
    };
    const first = (await (await post(nutritionLog, body)).json()) as {
      ids: string[];
    };
    const again = (await (await post(nutritionLog, body)).json()) as {
      ids: string[];
    };
    expect(first.ids).toHaveLength(3);
    expect(again.ids).toEqual(first.ids); // same derived ids both times

    expect(
      await count(
        `SELECT count(*) AS n FROM public.meal_logs ml
           JOIN public.meal_templates mt ON mt.id = ml.meal_template_id
          WHERE mt.name = $1 AND ml.date = '2026-03-02'`,
        [TEMPLATE],
      ),
    ).toBe(3);
  });

  it('a batch whose flush dropped halfway is safe to resend in full', async () => {
    // Device queued A then B. The first flush delivered A, then the network
    // dropped before B (and before A's response reached the device), so the
    // retry sends A and B again.
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const body = (clientId: string) => ({
      mode: 'adhoc',
      date: '2026-03-03',
      mealSlot: 'snack',
      items: [{ food: FOOD, quantity: 1 }],
      clientId,
      capturedAt: CAPTURED_AT,
    });
    await post(nutritionLog, body(a)); // delivered; response "lost"
    for (const id of [a, b]) {
      expect((await post(nutritionLog, body(id))).status).toBe(201);
    }
    expect(
      await count(
        `SELECT count(*) AS n FROM public.meal_logs WHERE id = ANY($1::uuid[])`,
        [[a, b]],
      ),
    ).toBe(2);
  });

  it('DELETE is idempotent: a retried undo succeeds instead of 404ing', async () => {
    const clientId = crypto.randomUUID();
    await post(nutritionLog, {
      mode: 'adhoc',
      date: '2026-03-04',
      mealSlot: 'lunch',
      items: [{ food: FOOD, quantity: 1 }],
      clientId,
    });
    const del = () =>
      nutritionDelete(new Request('http://localhost', { method: 'DELETE' }), {
        params: Promise.resolve({ id: clientId }),
      });
    expect(await (await del()).json()).toEqual({ ok: true, deleted: true });
    const retry = await del();
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true, deleted: false });
  });

  it('without a clientId (bot/script callers) it still inserts, dated by the explicit date', async () => {
    const res = await post(nutritionLog, {
      mode: 'adhoc',
      date: '2026-03-05',
      mealSlot: 'other',
      items: [{ food: FOOD, quantity: 1 }],
    });
    expect(res.status).toBe(201);
  });
});

describe('POST /api/general-health/log with a clientId', () => {
  it('a medication replayed lands once, with the client id and device created_at', async () => {
    const clientId = crypto.randomUUID();
    const body = {
      mode: 'medication',
      name: MED,
      kind: 'supplement',
      clientId,
      capturedAt: CAPTURED_AT,
    };
    for (let i = 0; i < 2; i++) {
      const res = await post(healthLog, body);
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: clientId });
    }
    const { rows } = await query<{ id: string; created_at: Date }>(
      `SELECT id, created_at FROM public.medications WHERE name = $1`,
      [MED],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.created_at.toISOString()).toBe(CAPTURED_AT);
  });

  it('a dose replayed lands once and is dated by capturedAt, not the server day', async () => {
    const clientId = crypto.randomUUID();
    const body = {
      mode: 'medication_dose',
      medicationName: MED,
      clientId,
      capturedAt: CAPTURED_AT,
    };
    await post(healthLog, body);
    await post(healthLog, body);
    const { rows } = await query<{ date: string }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date FROM public.medication_logs WHERE id = $1`,
      [clientId],
    );
    expect(rows).toEqual([{ date: '2026-03-01' }]);
  });

  it('rejects a malformed clientId instead of silently inserting a fresh row', async () => {
    const res = await post(healthLog, {
      mode: 'medication',
      name: MED,
      kind: 'supplement',
      clientId: 'not-a-uuid',
    });
    expect(res.status).toBe(400);
  });
});
