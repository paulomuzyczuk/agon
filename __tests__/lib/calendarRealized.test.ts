import {
  matchRealized,
  type Activity,
  type SessionToMatch,
} from '@/lib/calendarRealized';
import { outcomeNote, outcomeTitlePrefix } from '@/lib/sessionOutcome';

// MZY-417: realized data is attributed to a session by its CALENDAR date, never
// by comparing clock times. Cases below are the ones the 2026-10-27 audit found.

const run = (over: Partial<SessionToMatch>): SessionToMatch => ({
  id: 's',
  date: '2026-10-25',
  sessionKind: 'run',
  targetSessionType: 'long',
  targetDistanceKm: 21,
  ...over,
});
const act = (over: Partial<Activity>): Activity => ({
  id: 'a',
  kind: 'run',
  date: '2026-10-25',
  startLocal: '22:32',
  km: 19.412,
  durationS: 7396,
  source: 'strava',
  ...over,
});
const TODAY = '2026-10-27';

describe('matchRealized', () => {
  it('marks a session done with the actuals, whatever the planned clock time', () => {
    // Planned 14:30, ran at 22:32 — same calendar day, so it is that session.
    const [m] = matchRealized([run({ id: 'long' })], [act({ id: 'x' })], TODAY);
    expect(m).toMatchObject({
      sessionId: 'long',
      activityId: 'x',
      outcome: {
        status: 'done',
        plannedKm: 21,
        actualKm: 19.4,
        actualStart: '22:32',
        actualDurationMin: 123,
        source: 'strava',
      },
    });
  });

  it('marks a session not done when nothing was recorded on its calendar day', () => {
    const [m] = matchRealized(
      [run({ id: 'miss', date: '2026-10-11', targetDistanceKm: 25 })],
      [act({ date: '2026-10-12' })],
      TODAY,
    );
    expect(m).toMatchObject({
      activityId: null,
      outcome: { status: 'not_done', plannedKm: 25 },
    });
  });

  it("follows a calendar move: the session dated Sunday takes Sunday's run", () => {
    const [m] = matchRealized(
      [run({ id: 'moved', date: '2026-10-18' })],
      [
        act({ id: 'sun', date: '2026-10-18' }),
        act({ id: 'sat', date: '2026-10-17' }),
      ],
      TODAY,
    );
    expect(m?.activityId).toBe('sun');
  });

  it('gives two runs on one day to the sessions by closest distance', () => {
    const matched = matchRealized(
      [
        run({ id: 'easy', targetDistanceKm: 8 }),
        run({ id: 'long', targetDistanceKm: 20 }),
      ],
      [act({ id: 'a20', km: 19.6 }), act({ id: 'a8', km: 8.1 })],
      TODAY,
    );
    expect(matched.find((m) => m.sessionId === 'easy')?.activityId).toBe('a8');
    expect(matched.find((m) => m.sessionId === 'long')?.activityId).toBe('a20');
  });

  it('splits commute legs by half of the day and ignores the extra ride', () => {
    const leg = (id: string, type: string): SessionToMatch => ({
      id,
      date: '2026-10-20',
      sessionKind: 'bike',
      targetSessionType: type,
      targetDistanceKm: null,
    });
    const ride = (id: string, start: string, km: number): Activity =>
      act({ id, kind: 'bike', date: '2026-10-20', startLocal: start, km });
    const matched = matchRealized(
      [leg('home', 'commute_home'), leg('work', 'commute_to_work')],
      [
        ride('r2132', '21:32', 9.6),
        ride('r1921', '19:21', 5.7),
        ride('r0850', '08:50', 6.7),
      ],
      TODAY,
    );
    expect(matched.find((m) => m.sessionId === 'work')?.activityId).toBe(
      'r0850',
    );
    expect(matched.find((m) => m.sessionId === 'home')?.activityId).toBe(
      'r1921',
    );
  });

  it('does not count a ride as a run, or a run as a ride', () => {
    const [m] = matchRealized(
      [run({ id: 'r' })],
      [act({ kind: 'bike' })],
      TODAY,
    );
    expect(m?.outcome.status).toBe('not_done');
  });

  it('leaves lifts and today-or-later sessions alone (unknown, not missed)', () => {
    const matched = matchRealized(
      [
        run({ id: 'lift', sessionKind: 'lift' }),
        run({ id: 'today', date: TODAY }),
        run({ id: 'later', date: '2026-10-28' }),
      ],
      [],
      TODAY,
    );
    expect(matched).toEqual([]);
  });
});

describe('outcome rendering', () => {
  it('prefixes the title and words the note', () => {
    const done = {
      status: 'done' as const,
      plannedKm: 21,
      actualKm: 19.4,
      source: 'strava',
    };
    expect(outcomeTitlePrefix(done)).toBe('✅ ');
    expect(outcomeNote(done)).toBe(
      '✅ Done — 19.4 km (planned 21 km) · strava',
    );
    const missed = { status: 'not_done' as const, plannedKm: 25 };
    expect(outcomeTitlePrefix(missed)).toBe('❌ ');
    expect(outcomeNote(missed)).toBe(
      '❌ Not done — nothing recorded that day (planned 25 km)',
    );
    expect(outcomeTitlePrefix(null)).toBe('');
    expect(outcomeNote(null)).toBeNull();
  });
});
