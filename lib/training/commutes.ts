import type { PlannedSessionSpec, SessionType } from './trainingProgram';

// Bike commutes to work (athlete back in an office job, 2026-10-15): on each
// commute weekday, one ride to work in the morning and one home in the evening.
// They are planned_sessions like any other ride so they land on the "Agon
// Training" calendar and count as planned load, but they are NOT part of the
// training program — no block/week, no target distance (the route sets that),
// and they are seeded separately (`pnpm seed:commutes`) from the athlete
// profile's `commute` window rather than from a program file.
//
// The two legs share a date and a kind, so each needs its own plan_key suffix:
// the plan_key migration's "<date>:<kind>" assumed one bike per day.

export type CommuteLeg = Extract<
  SessionType,
  'commute_to_work' | 'commute_home'
>;

export const COMMUTE_TO_WORK: CommuteLeg = 'commute_to_work';
export const COMMUTE_HOME: CommuteLeg = 'commute_home';

/** The commute leg a session type names, or null for any other session. */
export function commuteLegOf(
  sessionType: string | null | undefined,
): CommuteLeg | null {
  return sessionType === COMMUTE_TO_WORK || sessionType === COMMUTE_HOME
    ? sessionType
    : null;
}

export interface CommuteWindow {
  /** ISO weekdays, 1=Mon … 7=Sun. */
  weekdays: number[];
  from: string; // YYYY-MM-DD, inclusive
  until: string; // YYYY-MM-DD, inclusive
}

const LEGS: { leg: CommuteLeg; suffix: string; description: string }[] = [
  {
    leg: 'commute_to_work',
    suffix: 'to-work',
    description: 'Commute ride — to work',
  },
  { leg: 'commute_home', suffix: 'home', description: 'Commute ride — home' },
];

/** ISO weekday (1=Mon … 7=Sun) of a plain calendar date. */
function isoWeekday(dateISO: string): number {
  const day = new Date(`${dateISO}T00:00:00Z`).getUTCDay(); // 0=Sun
  return day === 0 ? 7 : day;
}

function nextDay(dateISO: string): string {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Both commute legs for every commute weekday in the window, in date order.
 * Pure — no DB, no clock — so the seed script only handles persistence.
 */
export function expandCommuteRides(
  window: CommuteWindow,
): PlannedSessionSpec[] {
  const days = new Set(window.weekdays);
  const out: PlannedSessionSpec[] = [];
  for (let date = window.from; date <= window.until; date = nextDay(date)) {
    if (!days.has(isoWeekday(date))) continue;
    for (const { leg, suffix, description } of LEGS) {
      out.push({
        planKey: `${date}:bike:${suffix}`,
        dateISO: date,
        block: null,
        week: null,
        sessionKind: 'bike',
        description,
        targetDistanceKm: null,
        targetHrCap: null,
        targetSessionType: leg,
      });
    }
  }
  return out;
}
