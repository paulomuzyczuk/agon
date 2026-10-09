import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import {
  insertBodyMetric,
  upsertSourcedBodyMetric,
} from '@/services/bodyMetrics';

// Integration lane — requires a live local Postgres with migrations applied.
// Proves the Google Health body-metrics upsert (MZY-216) is idempotent on the
// partial (source, external_id) index and leaves manual rows untouched.

const SOURCE = 'test_source';
const DATE = '2031-01-15';

beforeAll(() => loadEnv());
afterEach(async () => {
  await query('DELETE FROM public.body_metrics WHERE date = $1', [DATE]);
});
afterAll(() => closeDbPool());

describe('upsertSourcedBodyMetric', () => {
  it('re-syncing the same external id updates in place', async () => {
    const rec = {
      date: DATE,
      source: SOURCE,
      externalId: 'weight:abc',
      weightKg: 75.5,
      bodyFatPct: null,
    };
    await upsertSourcedBodyMetric(rec);
    await upsertSourcedBodyMetric({ ...rec, weightKg: 75.2 });
    const { rows } = await query<{ weight_kg: string }>(
      'SELECT weight_kg FROM public.body_metrics WHERE source = $1 AND external_id = $2',
      [SOURCE, 'weight:abc'],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.weight_kg)).toBe(75.2);
  });

  it('manual rows (NULL identity) coexist on the same day', async () => {
    await insertBodyMetric({
      date: DATE,
      weightKg: 75,
      bodyFatPct: null,
      notes: null,
    });
    await insertBodyMetric({
      date: DATE,
      weightKg: 75.4,
      bodyFatPct: null,
      notes: null,
    });
    await upsertSourcedBodyMetric({
      date: DATE,
      source: SOURCE,
      externalId: 'weight:def',
      weightKg: 75.1,
      bodyFatPct: null,
    });
    const { rows } = await query(
      'SELECT id FROM public.body_metrics WHERE date = $1',
      [DATE],
    );
    expect(rows).toHaveLength(3);
  });
});
