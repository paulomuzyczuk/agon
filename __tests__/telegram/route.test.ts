import { executeCommand } from '@/services/telegram/handlers';
import type {
  AddAdHocRouteInput,
  AddAdHocRouteResult,
} from '@/services/adHocRoute';

// The /route command path only touches the injected addRoute seam (no DB / no
// routing API), so it's fully unit-testable. Verifies date resolution
// (today/tomorrow), the request passed through, and reply formatting.

function result(over: Partial<AddAdHocRouteResult> = {}): AddAdHocRouteResult {
  return {
    sessionCreated: false,
    throughLabels: ['Tiergarten'],
    finishLabel: 'Alexanderplatz',
    spineOnly: false,
    geocodeWarnings: [],
    calendarUpdated: true,
    routes: [
      {
        mapsUrl: 'https://maps/adhoc',
        distanceKm: 25,
        elevationGainM: 200,
        label: 'Route 1 · 25.0 km — Kreuzberg and Tiergarten',
      },
    ],
    ...over,
  };
}

describe('executeCommand /route', () => {
  it('resolves "tomorrow", forwards the request, and formats the reply', async () => {
    let seen: AddAdHocRouteInput | null = null;
    const reply = await executeCommand(
      {
        kind: 'route',
        targetKm: 25,
        through: ['Tiergarten'],
        finishNear: 'Alexanderplatz',
        day: 'tomorrow',
        profile: 'foot-walking',
      },
      {
        today: '2026-08-05',
        addRoute: async (input) => {
          seen = input;
          return result();
        },
      },
    );
    expect(seen).toEqual({
      dateISO: '2026-08-06', // tomorrow
      targetKm: 25,
      through: ['Tiergarten'],
      finishNear: 'Alexanderplatz',
      profile: 'foot-walking',
    });
    expect(reply).toContain('🧭 Ad hoc route');
    expect(reply).toContain(
      'through Tiergarten, finishing near Alexanderplatz',
    );
    expect(reply).toContain('Route 1 · 25.0 km — Kreuzberg and Tiergarten');
    expect(reply).toContain('https://maps/adhoc');
    expect(reply).toContain("Added to that day's run event");
  });

  it('notes when a new run was created for the day', async () => {
    const reply = await executeCommand(
      {
        kind: 'route',
        targetKm: 12,
        through: [],
        finishNear: null,
        day: 'today',
        profile: 'foot-walking',
      },
      {
        today: '2026-08-05',
        addRoute: async () => result({ sessionCreated: true }),
      },
    );
    expect(reply).toContain('Added a new run to your calendar');
  });

  it('warns when the through/finish route already meets the target', async () => {
    const reply = await executeCommand(
      {
        kind: 'route',
        targetKm: 3,
        through: [],
        finishNear: 'Alexanderplatz',
        day: 'today',
        profile: 'foot-walking',
      },
      {
        today: '2026-08-05',
        addRoute: async () => result({ spineOnly: true }),
      },
    );
    expect(reply).toMatch(/already meets your distance/);
  });

  it('shows a low-confidence place resolution (MZY-219)', async () => {
    const reply = await executeCommand(
      {
        kind: 'route',
        targetKm: 21,
        through: ['Club der Visionaere'],
        finishNear: null,
        day: 'today',
        profile: 'foot-walking',
      },
      {
        today: '2026-08-05',
        addRoute: async () =>
          result({
            geocodeWarnings: [
              '"Club der Visionaere" resolved to "Der Wellness Club"',
            ],
          }),
      },
    );
    expect(reply).toMatch(
      /⚠️ "Club der Visionaere" resolved to "Der Wellness Club"/,
    );
  });

  it('forwards a cycling profile and shows the bike icon', async () => {
    let seen: AddAdHocRouteInput | null = null;
    const reply = await executeCommand(
      {
        kind: 'route',
        targetKm: 40,
        through: [],
        finishNear: 'Grunewald',
        day: 'today',
        profile: 'cycling-regular',
      },
      {
        today: '2026-08-05',
        addRoute: async (input) => {
          seen = input;
          return result();
        },
      },
    );
    expect(seen).toMatchObject({ profile: 'cycling-regular' });
    expect(reply).toContain('🚴 Ad hoc route');
  });

  it('forwards the hill preference and echoes cycling preferences', async () => {
    let seen: AddAdHocRouteInput | null = null;
    const reply = await executeCommand(
      {
        kind: 'route',
        targetKm: 60,
        through: [],
        finishNear: null,
        day: 'today',
        profile: 'cycling-road',
        hills: 'flat',
      },
      {
        today: '2026-08-05',
        addRoute: async (input) => {
          seen = input;
          return result();
        },
      },
    );
    expect(seen).toMatchObject({ profile: 'cycling-road', hills: 'flat' });
    expect(reply).toContain('🚴 Ad hoc route (road, flat)');
  });

  it('replies with a friendly error when generation throws', async () => {
    const reply = await executeCommand(
      {
        kind: 'route',
        targetKm: 25,
        through: [],
        finishNear: null,
        day: 'today',
        profile: 'foot-walking',
      },
      {
        today: '2026-08-05',
        addRoute: async () => {
          throw new Error('geocode failed');
        },
      },
    );
    expect(reply).toMatch(/Route generation failed/);
  });
});
