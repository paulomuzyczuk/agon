import {
  sanitizeDetailLine,
  descriptionToLines,
  extractAthleteDetail,
  programDetailLines,
  sameDetail,
  detailHasOwnRoute,
} from '@/lib/calendarDetail';
import { reconcileSession, type SessionState } from '@/lib/calendarReconcile';
import { mapSessionToEvent } from '@/services/googleCalendar/eventMap';

// The bike/lift "detail" block shared by the calendar push and reconcile
// (MZY-262). Pure — no Google, no DB.

describe('sanitizeDetailLine', () => {
  it('keeps http(s) links and escapes everything else', () => {
    expect(
      sanitizeDetailLine(
        '• <a href="https://maps.google.com/?a=1&amp;b=2">Route 1</a> <b>x</b>',
      ),
    ).toBe('• <a href="https://maps.google.com/?a=1&amp;b=2">Route 1</a> x');
  });

  it('drops non-http links but keeps their text', () => {
    expect(sanitizeDetailLine('<a href="javascript:alert(1)">click</a>')).toBe(
      'click',
    );
  });

  it('is idempotent', () => {
    const once = sanitizeDetailLine('Back squat &amp; <i>pause</i> — 3×5');
    expect(sanitizeDetailLine(once)).toBe(once);
    expect(once).toBe('Back squat &amp; pause — 3×5');
  });
});

describe('descriptionToLines', () => {
  it('splits Agon <br> output and Calendar-editor paragraphs alike', () => {
    expect(descriptionToLines('a<br>b<div>c</div>')).toEqual([
      'a',
      'b',
      'c',
      '',
    ]);
  });
});

describe('extractAthleteDetail', () => {
  it("drops Agon's header, notes, route sections and footer", () => {
    const lines = descriptionToLines(
      [
        'Block 4 · Week 28',
        '⏰ Moved to 11:00 (normally 17:00) — moved in Google Calendar',
        'Easy Zone 2 spin',
        'One-way: home → RSO',
        '',
        '🗺️ Suggested routes from home:',
        '• <a href="https://m/1">Route 1 · 15 km</a>',
        '',
        'Planned by Agon',
      ].join('<br>'),
    );
    expect(extractAthleteDetail(lines)).toEqual([
      'Easy Zone 2 spin',
      'One-way: home → RSO',
    ]);
  });

  it('keeps a route section the athlete wrote under their own header', () => {
    const lines = descriptionToLines(
      'Notes<br><br>🗺️ Suggested route:<br>• <a href="https://m/rso">To RSO</a><br><br>Planned by Agon',
    );
    expect(extractAthleteDetail(lines)).toEqual([
      'Notes',
      '',
      '🗺️ Suggested route:',
      '• <a href="https://m/rso">To RSO</a>',
    ]);
  });
});

describe('sameDetail / detailHasOwnRoute', () => {
  it('ignores blank-line layout differences', () => {
    expect(sameDetail(['a', '', 'b'], ['a', 'b'])).toBe(true);
    expect(sameDetail(['a'], ['a', 'b'])).toBe(false);
  });

  it('spots a hand-written link', () => {
    expect(detailHasOwnRoute('x\n• <a href="https://m/r">r</a>')).toBe(true);
    expect(detailHasOwnRoute('just notes')).toBe(false);
    expect(detailHasOwnRoute(null)).toBe(false);
  });
});

describe('push → reconcile round trip', () => {
  // If what Agon renders read back as an edit, every sync would invent one.
  const cases: SessionState[] = [
    {
      date: '2026-10-01',
      startTime: '22:00',
      sessionKind: 'lift',
      targetDistanceKm: null,
      description: 'Lift A — full body',
      targetSessionType: 'A',
      detail: null,
    },
    {
      date: '2026-10-04',
      startTime: '17:00',
      sessionKind: 'bike',
      targetDistanceKm: null,
      description: 'Easy bike ride',
      targetSessionType: null,
      detail: null,
    },
    {
      date: '2026-10-04',
      startTime: '11:00',
      sessionKind: 'bike',
      targetDistanceKm: 16.3,
      description: 'Bike ride — Home → RSO',
      targetSessionType: null,
      detail:
        'Easy spin\nOne-way: home → RSO\n\n🗺️ Suggested route:\n• <a href="https://m/rso?a=1&amp;b=2">Route 1</a>',
    },
  ];

  it.each(cases)('$sessionKind "$description" reads back unchanged', (s) => {
    const event = mapSessionToEvent(
      {
        date: s.date,
        block: 4,
        week: 28,
        sessionKind: s.sessionKind,
        description: s.description!,
        targetDistanceKm: s.targetDistanceKm,
        targetHrCap: null,
        targetSessionType: s.targetSessionType ?? null,
        startTime: s.startTime,
        startTimePriority: 'strong',
        detail: s.detail,
      },
      {},
    );
    const action = reconcileSession(s, {
      dateTime: event.start.dateTime,
      summary: event.summary,
      description: event.description,
    });
    expect(action).toMatchObject({
      description: null,
      detail: null,
      targetDistanceKm: null,
      reason: null,
    });
  });

  it('renders the program default for a bike with no override', () => {
    expect(programDetailLines('bike', null)).toHaveLength(1);
  });
});

describe('commute ride detail', () => {
  it('gives each leg its own program detail', () => {
    expect(programDetailLines('bike', 'commute_to_work')[0]).toMatch(/fastest/);
    expect(programDetailLines('bike', 'commute_home')[0]).toMatch(/longer way/);
  });

  it('reminds about the chest strap on the morning ride only', () => {
    const strap = /chest strap/;
    expect(
      programDetailLines('bike', 'commute_to_work').some((l) => strap.test(l)),
    ).toBe(true);
    expect(
      programDetailLines('bike', 'commute_home').some((l) => strap.test(l)),
    ).toBe(false);
  });

  it("treats Agon's commute route section as Agon's, not the athlete's", () => {
    const e = mapSessionToEvent(
      {
        date: '2026-10-20',
        block: null,
        week: null,
        sessionKind: 'bike',
        description: 'Commute ride — to work',
        targetDistanceKm: null,
        targetHrCap: null,
        targetSessionType: 'commute_to_work',
      },
      {
        routes: [
          {
            mapsUrl: 'https://maps.example/c1',
            distanceKm: 8.4,
            elevationGainM: null,
          },
        ],
      },
    );
    // Round-tripping our own description must not read as a hand edit.
    expect(
      sameDetail(
        extractAthleteDetail(descriptionToLines(e.description)),
        programDetailLines('bike', 'commute_to_work'),
      ),
    ).toBe(true);
  });
});
