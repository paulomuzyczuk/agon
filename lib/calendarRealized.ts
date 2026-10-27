// Attribute realized activities to planned sessions (MZY-417). Pure.
//
// Attribution is by the session's CALENDAR date — where the athlete's event sits
// after any hand moves have been reconciled in — never by comparing clock times:
// moving an event in Calendar is how the athlete says "this run happened on
// that day". Within a day, activities go to sessions by closest distance;
// commute legs by the half of the day they sit in (a ride to work is a morning
// ride, a ride home is not).

import type { SessionOutcome } from './sessionOutcome';

export interface SessionToMatch {
  id: string;
  /** Resolved calendar date, YYYY-MM-DD. */
  date: string;
  sessionKind: 'run' | 'bike' | 'lift';
  targetSessionType: string | null;
  /** Resolved target distance before any realized overlay, km. */
  targetDistanceKm: number | null;
}

export interface Activity {
  id: string;
  kind: 'run' | 'bike';
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  /** Local start "HH:MM", or null when the source gave none. */
  startLocal: string | null;
  km: number;
  durationS: number | null;
  source: string;
}

export interface Matched {
  sessionId: string;
  outcome: SessionOutcome;
  /** The activity it was attributed to; null for a session that did not happen. */
  activityId: string | null;
}

const NOON = '13:00';

const legOf = (s: SessionToMatch): 'to_work' | 'home' | null =>
  s.targetSessionType === 'commute_to_work'
    ? 'to_work'
    : s.targetSessionType === 'commute_home'
      ? 'home'
      : null;

const roundKm = (km: number): number => Math.round(km * 10) / 10;

function doneOutcome(s: SessionToMatch, a: Activity): SessionOutcome {
  return {
    status: 'done',
    plannedKm: s.targetDistanceKm,
    actualKm: roundKm(a.km),
    ...(a.startLocal ? { actualStart: a.startLocal } : {}),
    ...(a.durationS ? { actualDurationMin: Math.round(a.durationS / 60) } : {}),
    source: a.source,
  };
}

/** Commute legs claim their ride first: earliest morning / earliest afternoon. */
function claimCommuteLegs(
  sessions: SessionToMatch[],
  pool: Activity[],
): Map<string, Activity> {
  const claimed = new Map<string, Activity>();
  const byStart = [...pool].sort((a, b) =>
    (a.startLocal ?? '').localeCompare(b.startLocal ?? ''),
  );
  for (const s of sessions) {
    const leg = legOf(s);
    if (!leg) continue;
    const pick = byStart.find(
      (a) =>
        !Array.from(claimed.values()).includes(a) &&
        a.startLocal !== null &&
        (leg === 'to_work' ? a.startLocal < NOON : a.startLocal >= NOON),
    );
    if (pick) claimed.set(s.id, pick);
  }
  return claimed;
}

/** The rest of the day's sessions take the closest-distance unclaimed activity. */
function claimByDistance(
  sessions: SessionToMatch[],
  pool: Activity[],
  claimed: Map<string, Activity>,
): void {
  const taken = new Set(Array.from(claimed.values()));
  for (const s of sessions) {
    if (claimed.has(s.id)) continue;
    const free = pool.filter((a) => !taken.has(a));
    if (free.length === 0) continue;
    const target = s.targetDistanceKm;
    const best =
      target === null
        ? free[0]!
        : free.reduce((x, y) =>
            Math.abs(y.km - target) < Math.abs(x.km - target) ? y : x,
          );
    claimed.set(s.id, best);
    taken.add(best);
  }
}

/**
 * Outcome for every run/bike session dated before `today`. Lifts are skipped
 * (no lift data is recorded yet, so "nothing found" would be a guess, not a
 * miss), and so is anything today or later.
 */
export function matchRealized(
  sessions: SessionToMatch[],
  activities: Activity[],
  today: string,
): Matched[] {
  const out: Matched[] = [];
  const groups = new Map<string, SessionToMatch[]>();
  for (const s of sessions) {
    if (s.sessionKind === 'lift' || s.date >= today) continue;
    const key = `${s.sessionKind}|${s.date}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const [key, group] of groups) {
    const [kind, date] = key.split('|') as ['run' | 'bike', string];
    const pool = activities.filter((a) => a.kind === kind && a.date === date);
    const claimed = claimCommuteLegs(group, pool);
    claimByDistance(group, pool, claimed);
    for (const s of group) {
      const a = claimed.get(s.id);
      out.push(
        a
          ? { sessionId: s.id, outcome: doneOutcome(s, a), activityId: a.id }
          : {
              sessionId: s.id,
              outcome: { status: 'not_done', plannedKm: s.targetDistanceKm },
              activityId: null,
            },
      );
    }
  }
  return out;
}
