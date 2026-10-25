import {
  mapSessionToEvent,
  mapRunToFuelingEvent,
  estimateRunMinutes,
  DEFAULT_TIME_ZONE,
  type PlannedSessionForEvent,
} from '@/services/googleCalendar/eventMap';

// Pure session → Calendar event mapping. No DB/network.

const base: PlannedSessionForEvent = {
  date: '2026-07-29',
  block: 3,
  week: 19,
  sessionKind: 'run',
  description: 'Easy run',
  targetDistanceKm: 8.5,
  targetHrCap: 156,
  targetSessionType: 'easy',
};

describe('estimateRunMinutes', () => {
  it('scales with distance and pace, floored at 30 min', () => {
    expect(estimateRunMinutes(8.5, 'easy')).toBe(51); // 8.5 × 6.0
    expect(estimateRunMinutes(19, 'long')).toBe(120); // 19 × 6.3 = 119.7 → 120
    expect(estimateRunMinutes(3, 'easy')).toBe(30); // 18 → floored to 30
  });

  it('uses the default pace for unknown/quality types', () => {
    expect(estimateRunMinutes(10, 'vo2max')).toBe(55); // 10 × 5.5
    expect(estimateRunMinutes(10, null)).toBe(60); // default 6.0
  });

  it('never returns NaN for a null distance', () => {
    expect(estimateRunMinutes(null, 'easy')).toBe(45);
  });
});

describe('mapSessionToEvent — runs', () => {
  it('places an evening timed event with Berlin timezone', () => {
    const e = mapSessionToEvent(base);
    expect(e.start).toEqual({
      dateTime: '2026-07-29T19:00:00',
      timeZone: DEFAULT_TIME_ZONE,
    });
    // 8.5 km × 6.0 = 51 min → 19:51
    expect(e.end.dateTime).toBe('2026-07-29T19:51:00');
  });

  it('puts distance in the summary and targets in the description', () => {
    const e = mapSessionToEvent(base);
    expect(e.summary).toBe('🏃 Easy run — 8.5 km');
    expect(e.description).toContain('Block 3 · Week 19');
    expect(e.description).toContain('Target: 8.5 km');
    expect(e.description).toContain('HR cap: 156 bpm');
  });

  it('marks a quality run as uncapped and lists the interval structure', () => {
    const e = mapSessionToEvent({
      ...base,
      description: 'Quality — VO2max / tempo',
      targetSessionType: 'vo2max',
      targetHrCap: null,
      targetDistanceKm: 10,
    });
    expect(e.description).toContain('Quality session — no HR cap');
    expect(e.description).toContain('Warm-up: 2 km easy');
    expect(e.description).toContain('5×1000 m @ 5K pace, 400 m jog recovery');
    expect(e.description).toContain('Cool-down: 2 km easy');
    expect(e.end.dateTime).toBe('2026-07-29T19:55:00'); // 10 × 5.5 = 55 min
  });
});

describe('mapSessionToEvent — long-run fueling reminder', () => {
  const longRunFuelingInputs = { paceSPerKm: 360, sweatRateLPerH: 0.8 };

  it('adds the Vaseline + refueling lines for a run at/above the threshold', () => {
    const e = mapSessionToEvent(
      { ...base, targetDistanceKm: 21.1 },
      { longRunFuelingInputs },
    );
    expect(e.description).toContain(
      '🧴 Vaseline / anti-chafing balm — apply before you start',
    );
    expect(e.description).toContain('🥤 Suggested refueling:');
    expect(e.description).toContain('water');
    expect(e.description).toContain('carbs');
    expect(e.description).toContain('sodium');
  });

  it('omits the reminder below the distance threshold', () => {
    const e = mapSessionToEvent(
      { ...base, targetDistanceKm: 8.5 },
      { longRunFuelingInputs },
    );
    expect(e.description).not.toContain('Vaseline');
  });

  it('omits the reminder when fueling inputs are not supplied', () => {
    const e = mapSessionToEvent({ ...base, targetDistanceKm: 21.1 });
    expect(e.description).not.toContain('Vaseline');
  });

  it('never applies to lift sessions', () => {
    const e = mapSessionToEvent(
      {
        ...base,
        sessionKind: 'lift',
        targetDistanceKm: null,
        targetSessionType: 'A',
      },
      { longRunFuelingInputs },
    );
    expect(e.description).not.toContain('Vaseline');
  });
});

describe('mapSessionToEvent — route links', () => {
  it('renders clickable HTML links whose text describes each route', () => {
    const e = mapSessionToEvent(base, {
      routes: [
        {
          mapsUrl: 'https://maps.example/a',
          distanceKm: 8.3,
          elevationGainM: 95,
          direction: 'N',
          label: 'Route 1 · 8.3 km — Tempelhof and Schöneberg',
        },
        {
          mapsUrl: 'https://maps.example/b',
          distanceKm: 8.1,
          elevationGainM: 70,
          direction: 'E',
          label: 'Route 2 · 8.1 km — Kreuzberg',
        },
      ],
    });
    expect(e.description).toContain('🗺️ Suggested routes from home:');
    // Clickable anchor with descriptive text, not a raw URL line.
    expect(e.description).toContain(
      '<a href="https://maps.example/a">Route 1 · 8.3 km — Tempelhof and Schöneberg · +95 m · 11 m/km</a>',
    );
    expect(e.description).toContain(
      '<a href="https://maps.example/b">Route 2 · 8.1 km — Kreuzberg · +70 m · 9 m/km</a>',
    );
  });

  it('falls back to distance + direction when no label is given', () => {
    const e = mapSessionToEvent(base, {
      routes: [
        {
          mapsUrl: 'https://maps.example/a',
          distanceKm: 8.4,
          elevationGainM: null,
          direction: 'S',
        },
      ],
    });
    expect(e.description).toContain(
      '<a href="https://maps.example/a">Route 1 · 8.4 km · heading S</a>',
    );
  });

  it('escapes & in the Maps URL for the href attribute', () => {
    const e = mapSessionToEvent(base, {
      routes: [
        {
          mapsUrl: 'https://maps/dir?a=1&b=2',
          distanceKm: 8,
          elevationGainM: null,
          label: 'Route 1',
        },
      ],
    });
    expect(e.description).toContain('href="https://maps/dir?a=1&amp;b=2"');
  });

  it('renders auto + ad-hoc routes as two separate labelled sections', () => {
    const e = mapSessionToEvent(base, {
      routes: [
        {
          mapsUrl: 'https://maps/auto1',
          distanceKm: 8.4,
          elevationGainM: 95,
          label: 'Route 1 · 8.4 km — Schoeneberg',
        },
      ],
      adHocRoutes: [
        {
          mapsUrl: 'https://maps/adhoc1',
          distanceKm: 25,
          elevationGainM: 200,
          label: 'Route 1 · 25.0 km — Tiergarten and Mitte',
        },
      ],
    });
    expect(e.description).toContain('🗺️ Suggested routes from home:');
    expect(e.description).toContain('🧭 Ad hoc routes:');
    expect(e.description).toContain(
      '<a href="https://maps/auto1">Route 1 · 8.4 km — Schoeneberg · +95 m · 11 m/km</a>',
    );
    expect(e.description).toContain(
      '<a href="https://maps/adhoc1">Route 1 · 25.0 km — Tiergarten and Mitte · +200 m · 8 m/km</a>',
    );
    // auto section comes before the ad-hoc section
    expect(e.description.indexOf('Suggested routes')).toBeLessThan(
      e.description.indexOf('Ad hoc routes'),
    );
  });

  it('omits the ad-hoc section when there are no ad-hoc routes', () => {
    const e = mapSessionToEvent(base, {
      routes: [
        {
          mapsUrl: 'https://maps/a',
          distanceKm: 8,
          elevationGainM: null,
          label: 'R1',
        },
      ],
    });
    expect(e.description).not.toContain('Ad hoc routes');
  });

  it('renders route links on a bike event, alongside the Zone 2 spin line', () => {
    const bike: PlannedSessionForEvent = {
      date: '2026-09-08',
      block: 4,
      week: 1,
      sessionKind: 'bike',
      description: 'Easy bike ride',
      targetDistanceKm: null,
      targetHrCap: null,
      targetSessionType: null,
    };
    const e = mapSessionToEvent(bike, {
      routes: [
        {
          mapsUrl: 'https://maps.example/bike-a',
          distanceKm: 15.1,
          elevationGainM: 40,
          direction: 'N',
          label: 'Route 1 · 15.1 km — Grunewald',
        },
      ],
    });
    expect(e.description).toContain(
      'Easy Zone 2 spin — low-impact aerobic reserve, not a training target',
    );
    expect(e.description).toContain('🗺️ Suggested routes from home:');
    expect(e.description).toContain(
      '<a href="https://maps.example/bike-a">Route 1 · 15.1 km — Grunewald · +40 m · 3 m/km</a>',
    );
  });

  it('never adds route links to a lift event', () => {
    const e = mapSessionToEvent(
      {
        date: '2026-07-29',
        block: 3,
        week: 19,
        sessionKind: 'lift',
        description: 'Lift — Push',
        targetDistanceKm: null,
        targetHrCap: null,
        targetSessionType: 'push',
      },
      {
        routes: [
          {
            mapsUrl: 'https://maps.example/a',
            distanceKm: 8,
            elevationGainM: null,
          },
        ],
      },
    );
    expect(e.description).not.toContain('Suggested routes');
  });
});

describe('mapSessionToEvent — lifts', () => {
  const lift: PlannedSessionForEvent = {
    date: '2026-07-29',
    block: 3,
    week: 19,
    sessionKind: 'lift',
    description: 'Lift — Push',
    targetDistanceKm: null,
    targetHrCap: null,
    targetSessionType: 'push',
  };

  it('places a late-evening 60-minute event listing the exercises', () => {
    const e = mapSessionToEvent(lift);
    expect(e.summary).toBe('🏋️ Lift — Push');
    expect(e.start.dateTime).toBe('2026-07-29T22:00:00');
    expect(e.end.dateTime).toBe('2026-07-29T23:00:00');
    // Every push exercise appears, one per row, with its sets × reps.
    expect(e.description).toContain('Bench press — 5×5');
    expect(e.description).toContain('Triceps pushdown — 3×12');
    expect(e.description).not.toContain('Session: push'); // detail replaces the stub
  });

  it('never overlaps the run on a double day (run 12:xx vs lift 22:00)', () => {
    const run = mapSessionToEvent(base);
    const l = mapSessionToEvent(lift); // 2026-07-29 is a Wednesday → weekday
    expect(run.end.dateTime < l.start.dateTime).toBe(true);
  });

  it('moves weekend lifts to 19:30 (Sat/Sun)', () => {
    const sunday = mapSessionToEvent({
      ...lift,
      date: '2026-08-02', // Sunday — Block 3 "Lift — Legs"
      description: 'Lift — Legs',
      targetSessionType: 'legs',
    });
    expect(sunday.start.dateTime).toBe('2026-08-02T19:30:00');
    expect(sunday.end.dateTime).toBe('2026-08-02T20:30:00'); // 60 min
  });

  it('keeps weekday lifts at 22:00', () => {
    // Sanity: the base lift date (Wed) stays on the weeknight slot.
    expect(mapSessionToEvent(lift).start.dateTime).toBe('2026-07-29T22:00:00');
  });
});

describe('mapSessionToEvent — bike hand edits (MZY-262)', () => {
  const bike: PlannedSessionForEvent = {
    ...base,
    date: '2026-10-04',
    sessionKind: 'bike',
    description: 'Bike ride — Home → RSO',
    targetDistanceKm: 16.3,
    targetHrCap: null,
    targetSessionType: null,
    startTime: '11:00',
    startTimePriority: 'strong',
    detail: 'One-way to RSO\n• <a href="https://m/rso?a=1&amp;b=2">Route 1</a>',
  };

  it('titles a ride with its hand-set distance and sizes it at an easy spin', () => {
    const ev = mapSessionToEvent(bike);
    expect(ev.summary).toBe('🚴 Bike ride — Home → RSO — 16.3 km');
    expect(ev.start.dateTime).toBe('2026-10-04T11:00:00');
    expect(ev.end.dateTime).toBe('2026-10-04T11:49:00'); // 16.3 km at 20 km/h
  });

  it("renders the athlete's detail in place of the default, link intact", () => {
    const ev = mapSessionToEvent(bike);
    expect(ev.description).toContain(
      'One-way to RSO<br>• <a href="https://m/rso?a=1&amp;b=2">Route 1</a>',
    );
    expect(ev.description).not.toContain('Easy Zone 2 spin');
  });

  it('keeps the flat default for a ride with no distance', () => {
    const ev = mapSessionToEvent({
      ...bike,
      description: 'Easy bike ride',
      targetDistanceKm: null,
      detail: null,
    });
    expect(ev.summary).toBe('🚴 Easy bike ride');
    expect(ev.description).toContain('Easy Zone 2 spin');
  });
});

describe('mapSessionToEvent — late sessions', () => {
  it('rolls an end time past midnight into the next day', () => {
    const ev = mapSessionToEvent({
      ...base,
      date: '2026-10-01',
      targetDistanceKm: 12,
      startTime: '23:15',
      startTimePriority: 'strong',
    });
    expect(ev.start.dateTime).toBe('2026-10-01T23:15:00');
    expect(ev.end.dateTime).toBe('2026-10-02T00:27:00'); // 12 km × 6.0 min
  });

  it('rolls across a month boundary', () => {
    const ev = mapSessionToEvent({
      ...base,
      date: '2026-10-31',
      targetDistanceKm: 12,
      startTime: '23:30',
      startTimePriority: 'strong',
    });
    expect(ev.end.dateTime).toBe('2026-11-01T00:42:00');
  });
});

describe('mapSessionToEvent — options', () => {
  it('honors custom timezone and start hours', () => {
    const e = mapSessionToEvent(base, {
      timeZone: 'UTC',
      runStartHour: 6,
    });
    expect(e.start).toEqual({
      dateTime: '2026-07-29T06:00:00',
      timeZone: 'UTC',
    });
  });
});

describe('mapSessionToEvent — per-session start time', () => {
  it('leaves the event at the default slot when there is no preferred time', () => {
    const e = mapSessionToEvent(base);
    expect(e.start.dateTime).toBe('2026-07-29T19:00:00');
    expect(e.description).not.toContain('⏰');
  });

  it('MOVES the event for a strong preference and explains why', () => {
    const e = mapSessionToEvent({
      ...base,
      startTime: '05:45',
      startTimePriority: 'strong',
      startTimeReason: 'Cyprus heat — 40 °C by midday',
    });
    expect(e.start.dateTime).toBe('2026-07-29T05:45:00');
    // The duration still applies from the new start (8.5 km easy = 51 min).
    expect(e.end.dateTime).toBe('2026-07-29T06:36:00');
    expect(e.description).toContain(
      '⏰ Moved to 05:45 (normally 19:00) — Cyprus heat — 40 °C by midday',
    );
  });

  it('does NOT move the event for a soft suggestion, but advises in the description', () => {
    const e = mapSessionToEvent({
      ...base,
      startTime: '06:15',
      startTimePriority: 'suggested',
      startTimeReason: 'cooler and quieter',
    });
    expect(e.start.dateTime).toBe('2026-07-29T19:00:00'); // untouched
    expect(e.description).toContain(
      '⏰ Suggestion: start at 06:15 rather than 19:00 — cooler and quieter',
    );
  });

  it('says nothing when the preferred time equals the default', () => {
    const e = mapSessionToEvent({
      ...base,
      startTime: '19:00',
      startTimePriority: 'strong',
      startTimeReason: 'evening is fine',
    });
    expect(e.start.dateTime).toBe('2026-07-29T19:00:00');
    expect(e.description).not.toContain('⏰');
  });

  it('accepts a Postgres TIME value with seconds', () => {
    const e = mapSessionToEvent({
      ...base,
      startTime: '06:00:00',
      startTimePriority: 'strong',
      startTimeReason: 'heat',
    });
    expect(e.start.dateTime).toBe('2026-07-29T06:00:00');
  });

  it('ignores a malformed time rather than producing an invalid event', () => {
    const e = mapSessionToEvent({
      ...base,
      startTime: 'quarter to six',
      startTimePriority: 'strong',
      startTimeReason: 'heat',
    });
    expect(e.start.dateTime).toBe('2026-07-29T19:00:00');
    expect(e.description).not.toContain('⏰');
  });

  it('still renders the note when no reason is given (suggested only)', () => {
    const e = mapSessionToEvent({
      ...base,
      startTime: '07:00',
      startTimePriority: 'suggested',
      startTimeReason: null,
    });
    expect(e.description).toContain(
      '⏰ Suggestion: start at 07:00 rather than 19:00',
    );
  });

  it('applies to lifts against their own evening default', () => {
    const e = mapSessionToEvent({
      ...base,
      sessionKind: 'lift',
      description: 'Lift — Push',
      targetSessionType: 'push',
      startTime: '18:00',
      startTimePriority: 'strong',
      startTimeReason: 'gym closes early',
    });
    // 2026-07-29 is a Wednesday → default lift slot is 22:00.
    expect(e.start.dateTime).toBe('2026-07-29T18:00:00');
    expect(e.description).toContain('⏰ Moved to 18:00 (normally 22:00)');
  });
});

describe('mapRunToFuelingEvent', () => {
  const longRun: PlannedSessionForEvent = {
    ...base,
    description: 'Long easy run',
    targetSessionType: 'long',
    targetDistanceKm: 20, // 20 × 6.3 = 126 min → 19:00-21:06, midpoint 20:03
  };

  it('returns null for a non-run session', () => {
    const runEvent = mapSessionToEvent(longRun);
    expect(
      mapRunToFuelingEvent({ ...longRun, sessionKind: 'lift' }, runEvent),
    ).toBeNull();
  });

  it('returns null below LONG_RUN_REMINDER_KM', () => {
    const shortRun = { ...longRun, targetDistanceKm: 8.5 };
    const runEvent = mapSessionToEvent(shortRun);
    expect(mapRunToFuelingEvent(shortRun, runEvent)).toBeNull();
  });

  it('sits at the midpoint of the run event, sharing its date and time zone', () => {
    const runEvent = mapSessionToEvent(longRun);
    const fuelingEvent = mapRunToFuelingEvent(longRun, runEvent);
    expect(fuelingEvent?.start).toEqual({
      dateTime: '2026-07-29T20:03:00',
      timeZone: DEFAULT_TIME_ZONE,
    });
    expect(fuelingEvent?.end.dateTime).toBe('2026-07-29T20:08:00'); // +5 min
  });

  it('doses via estimateFuelingBottles and names the bottle count in the summary', () => {
    const runEvent = mapSessionToEvent(longRun);
    const fuelingEvent = mapRunToFuelingEvent(longRun, runEvent);
    // 20 km → 3 bottles (2 base at 15 km, +1 per 5 km beyond).
    expect(fuelingEvent?.summary).toBe('🧃 Fueling — 3 bottles');
    expect(fuelingEvent?.description).toContain('Standard Fueling Solution ×3');
    expect(fuelingEvent?.description).toContain('270 kcal');
    expect(fuelingEvent?.description).toContain('69 g carbs');
    expect(fuelingEvent?.description).toContain('1419 mg sodium');
  });

  it('floors at 2 bottles right at the LONG_RUN_REMINDER_KM threshold', () => {
    const at15 = { ...longRun, targetDistanceKm: 15 };
    const runEvent = mapSessionToEvent(at15);
    const fuelingEvent = mapRunToFuelingEvent(at15, runEvent);
    expect(fuelingEvent?.summary).toBe('🧃 Fueling — 2 bottles');
  });
});

describe('mapSessionToEvent — commute rides', () => {
  const commute = (
    targetSessionType: 'commute_to_work' | 'commute_home',
  ): PlannedSessionForEvent => ({
    date: '2026-10-20',
    block: null,
    week: null,
    sessionKind: 'bike',
    description:
      targetSessionType === 'commute_to_work'
        ? 'Commute ride — to work'
        : 'Commute ride — home',
    targetDistanceKm: null,
    targetHrCap: null,
    targetSessionType,
  });

  it('puts the ride to work at 08:30 for half an hour', () => {
    const e = mapSessionToEvent(commute('commute_to_work'));
    expect(e.start.dateTime).toBe('2026-10-20T08:30:00');
    expect(e.end.dateTime).toBe('2026-10-20T09:00:00');
    expect(e.summary).toBe('🚴 Commute ride — to work');
  });

  it('brings the ride home in at 19:00, when the run slot starts', () => {
    const e = mapSessionToEvent(commute('commute_home'));
    expect(e.start.dateTime).toBe('2026-10-20T18:30:00');
    expect(e.end.dateTime).toBe('2026-10-20T19:00:00');
    const run = mapSessionToEvent({ ...base, date: '2026-10-20' });
    expect(run.start.dateTime).toBe(e.end.dateTime);
  });

  it('lists routes under a commute header, not "from home"', () => {
    const e = mapSessionToEvent(commute('commute_home'), {
      routes: [
        { mapsUrl: 'https://maps.example/c1', distanceKm: 8.4, elevationGainM: null },
      ],
    });
    expect(e.description).toContain('🗺️ Commute routes:');
    expect(e.description).not.toContain('Suggested routes from home');
    expect(e.description).not.toContain('Zone 2 spin');
  });

  it('still lets a strong preferred time move a commute', () => {
    const e = mapSessionToEvent({
      ...commute('commute_to_work'),
      startTime: '07:45',
      startTimePriority: 'strong',
      startTimeReason: 'early meeting',
    });
    expect(e.start.dateTime).toBe('2026-10-20T07:45:00');
    expect(e.description).toContain('⏰ Moved to 07:45 (normally 08:30) — early meeting');
  });
});
