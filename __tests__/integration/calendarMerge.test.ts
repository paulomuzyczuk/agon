import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import {
  upsertPlannedSession,
  getSessionsToSync,
  findSessionByDateAndKind,
} from '@/services/plannedSessions';
import {
  mergeCalendarAdjustment,
  upsertAdjustment,
} from '@/services/sessionAdjustments';
import { applyMutations } from '@/services/sync/apply';
import { formatHlc } from '@/lib/sync/hlc';
import type { PlannedSessionSpec } from '@/lib/training/trainingProgram';

// Integration lane (agon_test). MZY-208: Google Calendar is one more
// human-origin sync peer — its edits merge field by field, stamped with when
// the EVENT was edited, against every other writer of session_adjustments.

const PLAN_KEY = '2099-02-02:run';

const spec: PlannedSessionSpec = {
  planKey: PLAN_KEY,
  dateISO: '2099-02-02',
  block: 3,
  week: 23,
  sessionKind: 'run',
  description: 'Long run',
  targetDistanceKm: 20,
  targetHrCap: 158,
  targetSessionType: 'long',
};

async function resolved() {
  const s = await findSessionByDateAndKind('2099-02-02', 'run');
  return (await getSessionsToSync('2099-01-01')).find((r) => r.id === s!.id)!;
}

async function stamps() {
  const s = await findSessionByDateAndKind('2099-02-02', 'run');
  const { rows } = await query<{
    field_hlc: Record<string, { hlc: string; origin: string }>;
  }>(
    'SELECT field_hlc FROM public.session_adjustments WHERE planned_session_id = $1',
    [s!.id],
  );
  return rows[0]!.field_hlc;
}

async function cleanup() {
  await query('DELETE FROM public.planned_sessions WHERE plan_key = $1', [
    PLAN_KEY,
  ]);
}

beforeAll(async () => {
  loadEnv();
  await cleanup();
  await upsertPlannedSession(spec);
});

afterAll(async () => {
  await cleanup();
  await closeDbPool();
});

const at = (iso: string) => iso; // readability: the event's `updated`

it('a calendar move is stored as a human edit stamped at the event edit time', async () => {
  const s = await findSessionByDateAndKind('2099-02-02', 'run');
  const won = await mergeCalendarAdjustment(
    s!.id,
    { date: '2099-02-03', note: 'moved' },
    at('2026-09-20T10:00:00Z'),
  );
  expect(won).toEqual(expect.arrayContaining(['date', 'note']));
  expect((await resolved()).date).toBe('2099-02-03');
  expect((await stamps()).date).toEqual({
    hlc: formatHlc({
      wall: Date.parse('2026-09-20T10:00:00Z'),
      counter: 0,
      node: 'gcal',
    }),
    origin: 'human',
  });
});

it('both human: a later edit elsewhere beats an older calendar edit, and a newer calendar edit beats it back', async () => {
  const s = await findSessionByDateAndKind('2099-02-02', 'run');
  // Manual/device edit NOW (trigger-stamped at server time) — newer than the event edit.
  await upsertAdjustment(s!.id, { targetDistanceKm: 18 });
  // Reconcile re-reads a title edit the athlete made BEFORE that: it loses.
  expect(
    await mergeCalendarAdjustment(
      s!.id,
      { targetDistanceKm: 22, note: 'title' },
      at('2026-09-20T11:00:00Z'),
    ),
  ).not.toContain('target_distance_km');
  expect((await resolved()).targetDistanceKm).toBe(18);
  // The athlete edits the title again later on the calendar: now it wins.
  const later = new Date(Date.now() + 60_000).toISOString();
  expect(
    await mergeCalendarAdjustment(
      s!.id,
      { targetDistanceKm: 24, note: 'title' },
      later,
    ),
  ).toContain('target_distance_km');
  expect((await resolved()).targetDistanceKm).toBe(24);
});

it('re-running reconcile on an unchanged event is a no-op (same stamp = replay)', async () => {
  const s = await findSessionByDateAndKind('2099-02-02', 'run');
  expect(
    await mergeCalendarAdjustment(
      s!.id,
      { date: '2099-02-03', note: 'moved' },
      at('2026-09-20T10:00:00Z'),
    ),
  ).toEqual([]);
});

it('a program-derived (machine) write can never overwrite a calendar edit, however new', async () => {
  const s = await findSessionByDateAndKind('2099-02-02', 'run');
  const { rows } = await query<{ id: string }>(
    'SELECT id FROM public.session_adjustments WHERE planned_session_id = $1',
    [s!.id],
  );
  const future = formatHlc({ wall: Date.now(), counter: 0, node: 'program' });
  const res = await applyMutations(
    [
      {
        table: 'session_adjustments',
        id: rows[0]!.id,
        field: 'date',
        value: '2099-02-02',
        hlc: future,
        origin: 'machine',
      },
    ],
    { serverWriter: true },
  );
  expect(res[0]!.status).toBe('skipped');
  expect((await resolved()).date).toBe('2099-02-03');
});
