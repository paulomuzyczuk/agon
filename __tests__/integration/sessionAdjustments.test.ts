import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import {
  upsertPlannedSession,
  getSessionsToSync,
  findSessionByDateAndKind,
} from '@/services/plannedSessions';
import {
  upsertAdjustment,
  clearAdjustment,
} from '@/services/sessionAdjustments';
import type { PlannedSessionSpec } from '@/lib/training/trainingProgram';

// Integration lane — requires a live local Postgres with migrations applied:
//   pnpm db:up && pnpm migrate && pnpm test:integration
//
// Proves the property the whole overlay exists for: re-seeding the program from
// docs/training-program.local.md must NOT destroy what the athlete actually did. Before
// session_adjustments this was a live data-loss bug — upsertPlannedSession's
// ON CONFLICT list overwrites date/description/distance, so a re-seed silently
// reverted every hand-made change.

const PLAN_KEY = '2099-01-05:run'; // far-future; cannot collide with real program rows

function spec(over: Partial<PlannedSessionSpec> = {}): PlannedSessionSpec {
  return {
    planKey: PLAN_KEY,
    dateISO: '2099-01-05',
    block: 3,
    week: 22,
    sessionKind: 'run',
    description: 'Long run',
    targetDistanceKm: 19.4,
    targetHrCap: 158,
    targetSessionType: 'long',
    ...over,
  };
}

async function cleanup(): Promise<void> {
  // session_adjustments cascades on the FK, so removing the plan row is enough.
  await query(`DELETE FROM public.planned_sessions WHERE plan_key = $1`, [
    PLAN_KEY,
  ]);
}

beforeAll(async () => {
  loadEnv(); // integration lane reads DATABASE_URL from .env.local
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  await closeDbPool();
});

describe('session adjustments survive a re-seed', () => {
  it('keeps the athlete’s overrides when the program is seeded again', async () => {
    await upsertPlannedSession(spec());
    const session = await findSessionByDateAndKind('2099-01-05', 'run');
    expect(session).not.toBeNull();

    // The athlete moves it a day later and lengthens it.
    await upsertAdjustment(
      session!.id,
      { date: '2099-01-06', targetDistanceKm: 25, note: 'swapped with Sunday' },
      'manual',
    );

    // Re-seeding rewrites the PLAN row in full — the exact operation that used
    // to clobber everything.
    await upsertPlannedSession(spec());

    const rows = await getSessionsToSync('2099-01-01');
    const resolved = rows.find((r) => r.id === session!.id);
    expect(resolved).toBeDefined();
    expect(resolved!.date).toBe('2099-01-06'); // adjustment still applied
    expect(resolved!.targetDistanceKm).toBe(25);
    expect(resolved!.adjustmentNote).toContain('moved from 2099-01-05');

    // ...and the program row underneath is untouched, so the plan is still true.
    const { rows: planRows } = await query<{
      date: string;
      target_distance_km: string;
    }>(
      `SELECT to_char(date,'YYYY-MM-DD') AS date, target_distance_km
         FROM public.planned_sessions WHERE plan_key = $1`,
      [PLAN_KEY],
    );
    expect(planRows[0]!.date).toBe('2099-01-05');
    expect(Number(planRows[0]!.target_distance_km)).toBe(19.4);
  });

  it('patches one override without dropping the others', async () => {
    const session = await findSessionByDateAndKind('2099-01-05', 'run');
    await upsertAdjustment(session!.id, { targetHrCap: 150 }, 'manual');

    const resolved = (await getSessionsToSync('2099-01-01')).find(
      (r) => r.id === session!.id,
    );
    expect(resolved!.targetHrCap).toBe(150);
    expect(resolved!.date).toBe('2099-01-06'); // earlier date move preserved
    expect(resolved!.targetDistanceKm).toBe(25);
  });

  it('reverts to the program when the adjustment is cleared', async () => {
    const session = await findSessionByDateAndKind('2099-01-05', 'run');
    expect(await clearAdjustment(session!.id)).toBe(true);

    const resolved = (await getSessionsToSync('2099-01-01')).find(
      (r) => r.id === session!.id,
    );
    expect(resolved!.date).toBe('2099-01-05');
    expect(resolved!.targetDistanceKm).toBe(19.4);
    expect(resolved!.adjustmentNote).toBeNull();
  });

  it('a new adjustment after a clear starts fresh (the soft-deleted overrides stay gone)', async () => {
    // MZY-206 made clear a soft delete; re-adjusting restores the row but must
    // not resurrect the distance/date overrides the clear dropped.
    const session = await findSessionByDateAndKind('2099-01-05', 'run');
    expect(await clearAdjustment(session!.id)).toBe(false); // already cleared: idempotent
    await upsertAdjustment(session!.id, { targetHrCap: 145 });

    const resolved = (await getSessionsToSync('2099-01-01')).find(
      (r) => r.id === session!.id,
    );
    expect(resolved!.targetHrCap).toBe(145);
    expect(resolved!.date).toBe('2099-01-05');
    expect(resolved!.targetDistanceKm).toBe(19.4);
  });
});
