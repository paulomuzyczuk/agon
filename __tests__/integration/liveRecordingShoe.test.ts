import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import {
  finishLiveRecording,
  UnknownShoeError,
} from '@/services/liveRecording';
import { linkRunGear, listRunShoes, upsertGear } from '@/services/gear';
import type { GpsStreamSample } from '@/lib/liveRecordingStreams';

// Integration lane (agon_test). The Save form's shoe pick: a registered shoe is
// stored on the run (shoe_used + run_gear), an unknown/non-shoe id is refused
// before anything is written, a retry with another shoe REPLACES the first (the
// HRM link stays), and the distance is kept to 2 decimals.

const STARTED_AT = Date.parse('2020-05-05T07:00:00Z');
const REC = 'itest-live-run-shoe';
const REC_UNKNOWN = 'itest-live-run-shoe-unknown';
const SHOE_A = { gear_id: 'itest-shoe-a', name: 'Itest Runner A' };
const SHOE_B = { gear_id: 'itest-shoe-b', name: 'Itest Runner B' };
const SHOE_OLD = { gear_id: 'itest-shoe-old', name: 'Itest Retired' };
const STRAP = { gear_id: 'itest-strap', name: 'Itest Strap' };

const LAT0 = 52.4731234;
const LNG0 = 13.4012345;

/** 5 min, one fix per second, ~3 m/s north: about 0.9 km. */
function track(): GpsStreamSample[] {
  return Array.from({ length: 301 }, (_, s) => ({
    tMs: STARTED_AT + s * 1000 + 120,
    lat: LAT0 + (s * 3.01) / 111_320,
    lng: LNG0,
    altitudeM: 41.3,
    accuracyM: 3.6,
    speedMps: 3.01,
    deviceId: 'phone-gps',
    deviceName: 'Phone GPS',
    deviceKind: 'gps' as const,
  }));
}

const input = (over: Record<string, unknown> = {}) => ({
  recordingId: REC,
  startedAt: STARTED_AT,
  endedAt: STARTED_AT + 301_000,
  deviceName: 'HRM 200',
  samples: [],
  gps: track(),
  ...over,
});

const shoesOf = async (runId: string) =>
  (
    await query<{ gear_id: string }>(
      'SELECT gear_id FROM public.run_gear WHERE run_id = $1 ORDER BY gear_id',
      [runId],
    )
  ).rows.map((r) => r.gear_id);

async function cleanup() {
  await query(
    `DELETE FROM public.runs WHERE source = 'live_recording' AND external_id = ANY($1)`,
    [[REC, REC_UNKNOWN]],
  );
  await query('DELETE FROM public.gear WHERE gear_id LIKE $1', ['itest-%']);
}

beforeAll(async () => {
  loadEnv();
  await cleanup();
  for (const g of [SHOE_A, SHOE_B, SHOE_OLD]) {
    await upsertGear({ ...g, source: 'local', category: 'shoe' });
  }
  await upsertGear({ ...STRAP, source: 'local', category: 'hrm' });
  await query('UPDATE public.gear SET retired = TRUE WHERE gear_id = $1', [
    SHOE_OLD.gear_id,
  ]);
});

afterAll(async () => {
  await cleanup();
  await closeDbPool();
});

describe('finishLiveRecording — the shoe', () => {
  it('stores the picked shoe on the run and links it', async () => {
    const res = await finishLiveRecording(
      input({ gearId: SHOE_A.gear_id }) as never,
    );
    const { rows } = await query<{ shoe_used: string; distance_km: string }>(
      'SELECT shoe_used, distance_km FROM public.runs WHERE id = $1',
      [res.runId],
    );
    expect(rows[0]!.shoe_used).toBe(SHOE_A.name);
    expect(await shoesOf(res.runId)).toEqual([SHOE_A.gear_id]);
    // Distance is kept to 2 decimals (10 m), never 3.
    expect(rows[0]!.distance_km).toMatch(/^\d+\.\d{2}0$/);
    expect(res.distanceSource).toBe('gps');
  });

  it('a retried save with another shoe replaces the first, keeps the strap', async () => {
    const first = await finishLiveRecording(
      input({ gearId: SHOE_A.gear_id }) as never,
    );
    await linkRunGear(first.runId, STRAP.gear_id);
    const retry = await finishLiveRecording(
      input({ gearId: SHOE_B.gear_id }) as never,
    );
    expect(retry.runId).toBe(first.runId);
    expect(retry.status).toBe('updated');
    expect(await shoesOf(retry.runId)).toEqual(
      [SHOE_B.gear_id, STRAP.gear_id].sort(),
    );
    const { rows } = await query<{ shoe_used: string }>(
      'SELECT shoe_used FROM public.runs WHERE id = $1',
      [retry.runId],
    );
    expect(rows[0]!.shoe_used).toBe(SHOE_B.name);
  });

  it('saves without a shoe when none is picked', async () => {
    const res = await finishLiveRecording(input() as never);
    const { rows } = await query<{ shoe_used: string | null }>(
      'SELECT shoe_used FROM public.runs WHERE id = $1',
      [res.runId],
    );
    expect(rows[0]!.shoe_used).toBeNull();
    expect((await shoesOf(res.runId)).includes(SHOE_A.gear_id)).toBe(false);
  });

  it.each([
    ['an unknown id', 'itest-no-such-shoe'],
    ['gear that is not a shoe', STRAP.gear_id],
  ])('refuses %s and writes nothing', async (_label, gearId) => {
    await expect(
      finishLiveRecording(input({ recordingId: REC_UNKNOWN, gearId }) as never),
    ).rejects.toBeInstanceOf(UnknownShoeError);
    const { rows } = await query(
      `SELECT 1 FROM public.runs WHERE source = 'live_recording' AND external_id = $1`,
      [REC_UNKNOWN],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('listRunShoes', () => {
  it('lists active shoes only, the most recently used first', async () => {
    const shoes = (await listRunShoes()).filter((s) =>
      s.gearId.startsWith('itest-'),
    );
    const ids = shoes.map((s) => s.gearId);
    expect(ids).not.toContain(SHOE_OLD.gear_id); // retired
    expect(ids).not.toContain(STRAP.gear_id); // not a shoe
    expect(ids).toEqual([SHOE_B.gear_id, SHOE_A.gear_id]); // B was used last (2020-05-05)
    expect(shoes[0]!.lastUsedAt).toBe('2020-05-05T07:00:00.000Z');
    expect(shoes[1]!.lastUsedAt).toBeNull();
  });
});
