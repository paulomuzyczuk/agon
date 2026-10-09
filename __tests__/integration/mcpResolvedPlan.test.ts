import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { closeReadPool } from '@/services/mcp/readonlyDb';
import {
  upsertPlannedSession,
  findSessionByDateAndKind,
  setSessionStatus,
} from '@/services/plannedSessions';
import { upsertAdjustment } from '@/services/sessionAdjustments';
import { weeklyPlan } from '@/services/mcp/curated';
import { nutritionSummary } from '@/services/mcp/curatedNutrition';
import { programWeekRange } from '@/lib/training/trainingBlocks';
import type { PlannedSessionSpec } from '@/lib/training/trainingProgram';

// Integration lane — requires a live local Postgres with migrations applied:
//   pnpm db:up && pnpm migrate && pnpm test:integration
//
// MZY-265: the MCP plan reads (weekly_plan, nutrition_summary) go through the
// read-only pool but must still see the session_adjustments overlay — the real
// SQL join, windowed on the RESOLVED date, not just the pure resolver.

const KEY_PREFIX = 'mzy265-test:'; // far-future rows; cannot collide with the program

let week: { start: string; end: string };
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);

function spec(
  over: Partial<PlannedSessionSpec> & { dateISO: string },
): PlannedSessionSpec {
  return {
    planKey: `${KEY_PREFIX}${over.dateISO}:${over.sessionKind ?? 'run'}`,
    block: 4,
    week: 999,
    sessionKind: 'run',
    description: 'Long easy run',
    targetDistanceKm: 19,
    targetHrCap: 150,
    targetSessionType: 'long',
    ...over,
  };
}

async function idOf(dateISO: string, kind: 'run' | 'lift'): Promise<string> {
  const s = await findSessionByDateAndKind(dateISO, kind);
  if (!s) throw new Error(`no ${kind} on ${dateISO}`);
  return s.id;
}

async function cleanup(): Promise<void> {
  // session_adjustments cascades on the FK.
  await query(`DELETE FROM public.planned_sessions WHERE plan_key LIKE $1`, [
    `${KEY_PREFIX}%`,
  ]);
}

beforeAll(async () => {
  loadEnv();
  week = programWeekRange('2099-06-17')!; // a Monday–Sunday program week
  await cleanup();

  const sat = addDays(week.start, 5);
  const thu = addDays(week.start, 3);
  const sun = week.end;
  const wed = addDays(week.start, 2);
  const tue = addDays(week.start, 1);

  // Sat long run, distance edited 19 → 21.2.
  await upsertPlannedSession(spec({ dateISO: sat }));
  await upsertAdjustment(
    await idOf(sat, 'run'),
    { targetDistanceKm: 21.2, note: 'distance edited' },
    'manual',
  );
  // Thu lift moved to Sun.
  await upsertPlannedSession(
    spec({
      dateISO: thu,
      sessionKind: 'lift',
      description: 'Lift B — full body',
      targetDistanceKm: null,
      targetHrCap: null,
      targetSessionType: null,
    }),
  );
  await upsertAdjustment(await idOf(thu, 'lift'), { date: sun }, 'manual');
  // Wed run moved OUT of the week (to next Monday).
  await upsertPlannedSession(
    spec({ dateISO: wed, description: 'Easy run', targetDistanceKm: 9 }),
  );
  await upsertAdjustment(
    await idOf(wed, 'run'),
    { date: addDays(sun, 1) },
    'manual',
  );
  // Tue run skipped.
  await upsertPlannedSession(
    spec({ dateISO: tue, description: 'Tempo run', targetDistanceKm: 8 }),
  );
  await setSessionStatus(await idOf(tue, 'run'), 'skipped');
});

afterAll(async () => {
  await cleanup();
  await closeReadPool();
  await closeDbPool();
});

describe('weekly_plan reads the resolved plan', () => {
  it('shows edits, moves and skips, windowed on the resolved date', async () => {
    const out = await weeklyPlan(week.start);
    expect(out).toMatch(/\| run \| Long easy run \| 21\.2 \|/);
    expect(out).not.toMatch(/Long easy run \| 19 \|/);
    expect(out).toContain(`| Sun ${week.end} |`);
    expect(out).toMatch(/Lift B — full body.*📝 moved from/);
    expect(out).not.toContain('Easy run'); // moved into next week
    expect(out).toMatch(/Tempo run.*\| skipped \|/);
    expect(out).toMatch(/^\*\*Block 4 · /);
  });

  it('picks up a session moved in from the previous week', async () => {
    const out = await weeklyPlan(addDays(week.end, 1));
    expect(out).toMatch(/Easy run \| 9 \|.*📝 moved from/);
  });
});

describe('nutrition_summary counts exercise on the resolved day', () => {
  it('drops a moved-out session from its program day', async () => {
    const out = await nutritionSummary(addDays(week.start, 2));
    expect(out).toContain('no planned exercise today');
  });

  it('counts a moved-in session on its new day', async () => {
    const out = await nutritionSummary(addDays(week.end, 1));
    expect(out).toContain('estimated from planned exercise');
  });

  it('excludes a skipped session', async () => {
    const out = await nutritionSummary(addDays(week.start, 1));
    expect(out).toContain('no planned exercise today');
  });

  it('uses the edited distance', async () => {
    const edited = await nutritionSummary(addDays(week.start, 5));
    const m = edited.match(/\+ ([\d.]+) L estimated/);
    expect(m).not.toBeNull();
    // A 19 km run and a 21.2 km run must not cost the same water.
    const sat = addDays(week.start, 5);
    await query(
      `UPDATE public.session_adjustments SET target_distance_km = NULL
        WHERE planned_session_id = $1`,
      [await idOf(sat, 'run')],
    );
    const plain = await nutritionSummary(sat);
    const p = plain.match(/\+ ([\d.]+) L estimated/);
    expect(Number(m![1])).toBeGreaterThan(Number(p![1]));
  });
});
