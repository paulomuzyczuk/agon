import type { PlannedSessionSpec } from './trainingProgram';

// Monthly time trials over 5 / 10 / 15 / 21.1 km (asked 2026-10-15): progress
// checks that feed the race predictions (lib/racePrediction.ts buckets 21.1,
// not 21.2, for the half). At most one per calendar week; 5 and 10 km midweek
// (Wednesday), 15 and 21.1 km on Saturday.
//
// Inside a program block the trials are placed by hand in the program file
// (they replace a session of similar volume; peak, deload and taper weeks stay
// free). Outside any program,
// expandMonthlyTimeTrials() lays down four a month on a fixed pattern.

export type TimeTrialKm = 5 | 10 | 15 | 21.1;

/** The run fields a time trial carries, shared by both placement paths. */
export function timeTrialFields(distanceKm: TimeTrialKm): {
  description: string;
  targetSessionType: 'time_trial';
  targetDistanceKm: TimeTrialKm;
  targetHrCap: null;
} {
  return {
    description: 'Time trial',
    targetSessionType: 'time_trial',
    targetDistanceKm: distanceKm,
    targetHrCap: null, // all-out: no cap
  };
}

// Week of the month (1-based, by its Monday) → which trial and on which day
// (offset from Monday). Alternating short/long spreads the two hardest
// efforts two weeks apart. A month's fifth week, when it has one, stays free.
const MONTHLY_PATTERN: { week: number; dayOffset: number; km: TimeTrialKm }[] =
  [
    { week: 1, dayOffset: 2, km: 5 }, // Wednesday
    { week: 2, dayOffset: 5, km: 15 }, // Saturday
    { week: 3, dayOffset: 2, km: 10 }, // Wednesday
    { week: 4, dayOffset: 5, km: 21.1 }, // Saturday
  ];

const MS_PER_DAY = 86_400_000;

function addDays(dateISO: string, days: number): string {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/** The first Monday on or after the 1st of `month` ("YYYY-MM"). */
function firstMonday(month: string): string {
  const first = `${month}-01`;
  const day = new Date(`${first}T00:00:00Z`).getUTCDay(); // 0=Sun
  return addDays(first, (8 - day) % 7);
}

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * Four time trials a month for `months` months starting at `fromMonth`
 * ("YYYY-MM"). Weeks are counted by their Monday, so a week-4 Saturday can
 * fall in the next month — it still belongs to the month its week started in,
 * and the next month's week 1 starts after it, so the one-per-week rule holds.
 * Pure — no DB, no clock. Only for periods with no program sessions: the
 * plan_key "<date>:run" would otherwise collide with a program run.
 */
export function expandMonthlyTimeTrials(
  fromMonth: string,
  months: number,
): PlannedSessionSpec[] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(fromMonth)) {
    throw new Error(
      `expandMonthlyTimeTrials: fromMonth must be YYYY-MM, got '${fromMonth}'`,
    );
  }
  if (!Number.isInteger(months) || months < 1) {
    throw new Error(
      `expandMonthlyTimeTrials: months must be a positive integer, got ${months}`,
    );
  }
  const out: PlannedSessionSpec[] = [];
  let month = fromMonth;
  for (let i = 0; i < months; i++, month = nextMonth(month)) {
    const monday = firstMonday(month);
    for (const { week, dayOffset, km } of MONTHLY_PATTERN) {
      const date = addDays(monday, (week - 1) * 7 + dayOffset);
      out.push({
        planKey: `${date}:run`,
        dateISO: date,
        block: null,
        week: null,
        sessionKind: 'run',
        ...timeTrialFields(km),
      });
    }
  }
  return out;
}
