import { addAdHocRoute } from '@/services/adHocRoute';
import type { AddAdHocRouteDeps } from '@/services/adHocRoute';
import type { CalendarSyncRow } from '@/services/plannedSessions';

// Ad-hoc route orchestration with injected seams — no routing API, no DB, no
// Google Calendar. Verifies: attach-to-day's-run vs create-session, adhoc kind on
// save, both sections passed to the event upsert, and graceful calendar failure.

function runSession(over: Partial<CalendarSyncRow> = {}): CalendarSyncRow {
  return {
    id: 'ps-run',
    date: '2026-08-05',
    block: 3,
    week: 20,
    sessionKind: 'run',
    description: 'Easy run',
    targetDistanceKm: 25,
    targetHrCap: 156,
    targetSessionType: 'easy',
    gcalEventId: 'evt-1',
    gcalFuelingEventId: null,
    gcalPushed: null,
    ...over,
  };
}

function makeDeps(over: Partial<AddAdHocRouteDeps> = {}): {
  deps: AddAdHocRouteDeps;
  calls: {
    saveKind?: string;
    upsert?: unknown;
    attached: string[];
    created: boolean;
  };
} {
  const calls = { attached: [] as string[], created: false } as {
    saveKind?: string;
    upsert?: unknown;
    attached: string[];
    created: boolean;
  };
  const deps: AddAdHocRouteDeps = {
    findRunSession: async () => runSession(),
    createRunSession: async () => {
      calls.created = true;
      return runSession({ id: 'ps-new', gcalEventId: null });
    },
    generate: async () => ({
      start: { lat: 0, lng: 0, label: 'home' },
      through: [{ lat: 1, lng: 1, label: 'Tiergarten' }],
      finish: { lat: 2, lng: 2, label: 'Alexanderplatz' },
      targetKm: 25,
      profile: 'foot-walking' as const,
      candidates: [
        {
          seed: 1,
          distanceM: 25000,
          elevationGainM: 100,
          elevationGainPerKmM: 4,
          distanceErrorM: 0,
          coordinates: [[0, 0]],
          provider: 'ors',
          direction: 'NE',
        },
      ],
    }),
    describeVia: async () => ['Kreuzberg', 'Tiergarten'],
    save: async (_result, extras) => {
      calls.saveKind = extras?.kind;
      return {
        batchId: 'b1',
        suggestions: [
          {
            id: 'sug-1',
            batchId: 'b1',
            rank: 1,
            seed: 1,
            distanceM: 25000,
            elevationGainM: 100,
            provider: 'ors',
            gpx: '<gpx/>',
            mapsUrl: 'https://maps/adhoc',
            direction: 'NE',
            viaLabel: extras?.labels?.[0] ?? null,
            kind: 'adhoc',
            plannedSessionId: null,
          },
        ],
      };
    },
    attach: async (sug, ses) => {
      calls.attached.push(`${sug}->${ses}`);
      return { plannedDate: '2026-08-05', sessionKind: 'run' };
    },
    getAttached: async (_id, kind) =>
      kind === 'adhoc'
        ? [
            {
              mapsUrl: 'https://maps/adhoc',
              distanceM: 25000,
              elevationGainM: 100,
              direction: 'NE',
              viaLabel: 'Route 1 · 25.0 km — Kreuzberg and Tiergarten',
              kind: 'adhoc',
            },
          ]
        : [],
    upsertEvent: async (_s, routes) => {
      calls.upsert = routes;
    },
    ...over,
  };
  return { deps, calls };
}

describe('addAdHocRoute', () => {
  it('attaches to the day’s run, saves as adhoc, and pushes both sections', async () => {
    const { deps, calls } = makeDeps();
    const result = await addAdHocRoute(
      {
        dateISO: '2026-08-05',
        targetKm: 25,
        through: ['Tiergarten'],
        finishNear: 'Alexanderplatz',
      },
      deps,
    );
    expect(calls.created).toBe(false);
    expect(calls.saveKind).toBe('adhoc');
    expect(calls.attached).toEqual(['sug-1->ps-run']);
    expect(result.routes[0]!.label).toContain('Kreuzberg and Tiergarten');
    expect(result.throughLabels).toEqual(['Tiergarten']);
    expect(result.finishLabel).toBe('Alexanderplatz');
    expect(result.calendarUpdated).toBe(true);
    // both sections passed to the calendar upsert
    expect(calls.upsert).toMatchObject({
      adHocRoutes: [expect.objectContaining({ mapsUrl: 'https://maps/adhoc' })],
    });
  });

  it('creates a lightweight run session when none is planned that day', async () => {
    const { deps, calls } = makeDeps({ findRunSession: async () => null });
    const result = await addAdHocRoute(
      { dateISO: '2026-08-05', targetKm: 25 },
      deps,
    );
    expect(calls.created).toBe(true);
    expect(result.sessionCreated).toBe(true);
    expect(calls.attached).toEqual(['sug-1->ps-new']);
  });

  it('degrades gracefully when the calendar push fails (still persisted)', async () => {
    const { deps } = makeDeps({
      upsertEvent: async () => {
        throw new Error('no calendar tokens');
      },
    });
    const result = await addAdHocRoute(
      { dateISO: '2026-08-05', targetKm: 25 },
      deps,
    );
    expect(result.calendarUpdated).toBe(false);
    expect(result.routes).toHaveLength(1); // saved regardless
  });
});
