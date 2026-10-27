import {
  reconcileSession,
  splitLocalDateTime,
  type SessionState,
} from '@/lib/calendarReconcile';

// The conflict rules that decide whether an athlete's calendar edit rewrites a
// session. Pure — no Google, no DB.

const session: SessionState = {
  date: '2026-08-22',
  startTime: '12:00',
  sessionKind: 'run',
  targetDistanceKm: 17,
};

describe('splitLocalDateTime', () => {
  it('reads the local day and clock without shifting time zones', () => {
    // +02:00 Berlin: converting to UTC would report 15:30 and silently "move"
    // an event that never moved.
    expect(splitLocalDateTime('2026-08-23T17:30:00+02:00')).toEqual({
      date: '2026-08-23',
      time: '17:30',
    });
  });

  it('returns null for something unparseable', () => {
    expect(splitLocalDateTime('tomorrow-ish')).toBeNull();
  });
});

describe('reconcileSession', () => {
  it('does nothing when the event is where the session says', () => {
    const a = reconcileSession(session, {
      dateTime: '2026-08-22T12:00:00+02:00',
    });
    expect(a).toMatchObject({ date: null, startTime: null, skip: false });
  });

  it('records a date move', () => {
    const a = reconcileSession(session, {
      dateTime: '2026-08-23T12:00:00+02:00',
    });
    expect(a.date).toBe('2026-08-23');
    expect(a.startTime).toBeNull();
    expect(a.reason).toContain('2026-08-23');
  });

  it('records a time move', () => {
    const a = reconcileSession(session, {
      dateTime: '2026-08-22T17:30:00+02:00',
    });
    expect(a.date).toBeNull();
    expect(a.startTime).toBe('17:30');
  });

  it('records both when the athlete moved day and hour', () => {
    const a = reconcileSession(session, {
      dateTime: '2026-08-23T17:30:00+02:00',
    });
    expect(a).toMatchObject({ date: '2026-08-23', startTime: '17:30' });
  });

  it('treats a missing event as skipped, not as a move', () => {
    const a = reconcileSession(session, null);
    expect(a.skip).toBe(true);
    expect(a.date).toBeNull();
  });

  it('treats a cancelled event as skipped', () => {
    const a = reconcileSession(session, {
      status: 'cancelled',
      dateTime: '2026-08-22T12:00:00+02:00',
    });
    expect(a.skip).toBe(true);
  });

  it('honours an all-day move but leaves the start time alone', () => {
    // Stripping the clock must not wipe a program-set dawn start.
    const a = reconcileSession(session, { date: '2026-08-24' });
    expect(a).toMatchObject({ date: '2026-08-24', startTime: null });
  });

  it('ignores an all-day event that did not move', () => {
    expect(reconcileSession(session, { date: '2026-08-22' }).date).toBeNull();
  });

  it('leaves the session alone when the event time is unusable', () => {
    // Never guess: a malformed payload must not rewrite the athlete's calendar.
    const a = reconcileSession(session, { dateTime: 'not-a-date' });
    expect(a).toMatchObject({ date: null, startTime: null, skip: false });
  });

  it('records a hand-edited title distance', () => {
    const a = reconcileSession(session, {
      dateTime: '2026-08-22T12:00:00+02:00',
      summary: '🏃 Long easy run — 12 km',
    });
    expect(a).toMatchObject({
      date: null,
      startTime: null,
      targetDistanceKm: 12,
      skip: false,
    });
    expect(a.reason).toContain('12 km');
  });

  it('reads a decimal-comma title distance (MZY-259)', () => {
    const a = reconcileSession(session, {
      dateTime: '2026-08-22T12:00:00+02:00',
      summary: '🏃 Long easy run — 21,2 km',
    });
    expect(a.targetDistanceKm).toBe(21.2);
  });

  it('reads a decimal-dot title distance', () => {
    const a = reconcileSession(session, {
      dateTime: '2026-08-22T12:00:00+02:00',
      summary: '🏃 Long easy run — 21.2 km',
    });
    expect(a.targetDistanceKm).toBe(21.2);
  });

  it('ignores a title distance that matches the resolved value', () => {
    const a = reconcileSession(session, {
      dateTime: '2026-08-22T12:00:00+02:00',
      summary: '🏃 Long easy run — 17 km',
    });
    expect(a).toEqual(
      expect.objectContaining({
        date: null,
        startTime: null,
        targetDistanceKm: null,
      }),
    );
  });

  it('reports a moved date and an edited distance together', () => {
    const a = reconcileSession(session, {
      dateTime: '2026-08-23T12:00:00+02:00',
      summary: '🏃 Long easy run — 12 km',
    });
    expect(a).toMatchObject({ date: '2026-08-23', targetDistanceKm: 12 });
    expect(a.reason).toContain('2026-08-23');
    expect(a.reason).toContain('12 km');
  });

  it('never infers a distance edit for a non-run session', () => {
    const liftSession: SessionState = { ...session, sessionKind: 'lift' };
    const a = reconcileSession(liftSession, {
      dateTime: '2026-08-22T12:00:00+02:00',
      summary: '🏋️ Lift A — full body — 12 km', // pathological title, still ignored
    });
    expect(a.targetDistanceKm).toBeNull();
  });
});

describe('reconcileSession — bike and lift content edits (MZY-262)', () => {
  const bike: SessionState = {
    date: '2026-10-04',
    startTime: '11:00',
    sessionKind: 'bike',
    targetDistanceKm: null,
    description: 'Easy bike ride',
    targetSessionType: null,
    detail: null,
  };
  const lift: SessionState = {
    date: '2026-10-01',
    startTime: '22:00',
    sessionKind: 'lift',
    targetDistanceKm: null,
    description: 'Lift A — full body',
    targetSessionType: 'A',
    detail: null,
  };
  const at = (d: string, t: string) => `${d}T${t}:00+02:00`;

  it("reads a ride's renamed title and decimal-comma distance", () => {
    const a = reconcileSession(bike, {
      dateTime: at('2026-10-04', '11:00'),
      summary: '🚴 Bike ride — Home → RSO — 16,3 km',
    });
    expect(a).toMatchObject({
      description: 'Bike ride — Home → RSO',
      targetDistanceKm: 16.3,
      detail: null,
    });
    expect(a.reason).toContain('title edited');
  });

  it("reads a ride's hand-written notes and route as its detail", () => {
    const a = reconcileSession(bike, {
      dateTime: at('2026-10-04', '11:00'),
      summary: '🚴 Easy bike ride',
      description:
        'Block 4 · Week 28<br>Easy spin<br>One-way to RSO<br><br>🗺️ Suggested route:<br>• <a href="https://m/rso">Route 1</a><br><br>Planned by Agon',
    });
    expect(a.detail).toBe(
      'Easy spin\nOne-way to RSO\n\n🗺️ Suggested route:\n• <a href="https://m/rso">Route 1</a>',
    );
    expect(a.description).toBeNull();
  });

  it("reads a lift's edited exercise list", () => {
    const a = reconcileSession(lift, {
      dateTime: at('2026-10-01', '22:00'),
      summary: '🏋️ Lift A — full body',
      description:
        'Block 4 · Week 28<br><br>Front squat — 3×5<br>Bench press — 3×5<br><br>Planned by Agon',
    });
    expect(a.detail).toBe('Front squat — 3×5\nBench press — 3×5');
    expect(a.reason).toContain('details edited');
  });

  it('never clears a detail the athlete emptied', () => {
    const a = reconcileSession(lift, {
      dateTime: at('2026-10-01', '22:00'),
      summary: '🏋️ Lift A — full body',
      description: 'Block 4 · Week 28<br><br>Planned by Agon',
    });
    expect(a).toMatchObject({ detail: null, reason: null });
  });

  it("reads a run's renamed title but never its detail (MZY-266)", () => {
    const a = reconcileSession(
      { ...session, description: 'Long easy run' },
      {
        dateTime: '2026-08-22T12:00:00+02:00',
        summary: '🏃 Renamed run — 17 km',
        description: 'my own notes',
      },
    );
    expect(a).toMatchObject({
      description: 'Renamed run',
      targetDistanceKm: null,
      detail: null,
    });
    expect(a.reason).toContain('title edited to "Renamed run"');
  });

  it('keeps a renamed run alongside its edited distance and move (MZY-266)', () => {
    // The 2026-10-03 case: retitled "Half-Marathon — 21.2 km" and dragged a day;
    // the push rewrote it to "Easy run — 21.2 km".
    const a = reconcileSession(
      { ...session, description: 'Easy run', targetDistanceKm: 9 },
      {
        dateTime: '2026-08-23T17:30:00+02:00',
        summary: '🏃 Half-Marathon — 21.2 km',
      },
    );
    expect(a).toMatchObject({
      date: '2026-08-23',
      startTime: '17:30',
      description: 'Half-Marathon',
      targetDistanceKm: 21.2,
    });
  });

  it("ignores a run title that matches the program's name", () => {
    const a = reconcileSession(
      { ...session, description: 'Long easy run' },
      {
        dateTime: '2026-08-22T12:00:00+02:00',
        summary: '🏃 Long easy run — 17 km',
      },
    );
    expect(a).toMatchObject({ description: null, reason: null });
  });
});

// MZY-417: an edit is a difference from what Agon last pushed, never from the
// session's CURRENT defaults. 2026-10-25 changed the default slots and a dry run
// read 76 untouched events as hand moves.
describe('reconcileSession — pushed snapshot (MZY-417)', () => {
  // The default slot moved to 19:00 after this event was pushed at 12:00.
  const defaultChanged: SessionState = {
    ...session,
    startTime: '19:00',
    description: 'Easy run',
    pushed: {
      dateTime: '2026-08-22T12:00:00+02:00',
      summary: '🏃 Easy run — 17 km',
      description: 'Block 1 · Week 4<br>Planned by Agon',
    },
  };
  const untouched = {
    dateTime: '2026-08-22T12:00:00+02:00',
    summary: '🏃 Easy run — 17 km',
    description: 'Block 1 · Week 4<br>Planned by Agon',
  };

  it('does not read a changed default slot as a hand move', () => {
    expect(reconcileSession(defaultChanged, untouched).startTime).toBeNull();
    expect(reconcileSession(defaultChanged, untouched).reason).toBeNull();
  });

  it('still reads the same event as a move when no snapshot is known', () => {
    const legacy = { ...defaultChanged, pushed: null };
    expect(reconcileSession(legacy, untouched).startTime).toBe('12:00');
  });

  it('detects a real move away from the pushed time', () => {
    const moved = {
      ...untouched,
      dateTime: '2026-08-22T20:30:00+02:00',
    };
    expect(reconcileSession(defaultChanged, moved).startTime).toBe('20:30');
  });

  it('detects a hand-edited distance even when the time is untouched', () => {
    const edited = { ...untouched, summary: '🏃 Easy run — 21,1 km' };
    const action = reconcileSession(defaultChanged, edited);
    expect(action.targetDistanceKm).toBe(21.1);
    expect(action.startTime).toBeNull();
  });

  it('does not read stale pushed text as a hand-edited detail', () => {
    const bike: SessionState = {
      date: '2026-10-27',
      startTime: '08:30',
      sessionKind: 'bike',
      targetDistanceKm: null,
      targetSessionType: 'commute_to_work',
      pushed: {
        dateTime: '2026-10-27T17:00:00+01:00',
        summary: '🚴 Commute ride — to work',
        description:
          'Easy Zone 2 spin — low-impact aerobic reserve<br>Planned by Agon',
      },
    };
    const event = {
      dateTime: '2026-10-27T17:00:00+01:00',
      summary: '🚴 Commute ride — to work',
      description:
        'Easy Zone 2 spin — low-impact aerobic reserve<br>Planned by Agon',
    };
    expect(reconcileSession(bike, event)).toMatchObject({
      startTime: null,
      detail: null,
      reason: null,
    });
  });
});
