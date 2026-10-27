import {
  defaultSyncFromISO,
  SYNC_LOOKBACK_DAYS,
  syncTrainingCalendar,
  type CalendarSyncDeps,
} from '@/services/googleCalendar/sync';
import { GoogleCalendarNotFoundError } from '@/services/googleCalendar/client';
import { OrsRateLimitError } from '@/services/routing';
import type { CalendarSyncRow } from '@/services/plannedSessions';

// Sync orchestration with injected I/O seams — no Google, no DB. Verifies the
// insert-vs-patch decision, the 404-then-reinsert fallback, and that both
// dedicated calendars are ensured.

function row(over: Partial<CalendarSyncRow>): CalendarSyncRow {
  return {
    id: 'id-1',
    date: '2026-07-29',
    block: 3,
    week: 19,
    sessionKind: 'run',
    description: 'Easy run',
    targetDistanceKm: 8.5,
    targetHrCap: 156,
    targetSessionType: 'easy',
    gcalEventId: null,
    gcalFuelingEventId: null,
    gcalPushed: null,
    outcome: null,
    ...over,
  };
}

interface Calls {
  insert: unknown[];
  insertCalendarIds: string[];
  patch: unknown[];
  patchCalendarIds: string[];
  markSynced: { id: string; eventId: string }[];
  recordPushed: { id: string; eventId: string }[];
  markFuelingSynced: { id: string; eventId: string }[];
  ensured: string[];
  removed: string[];
  removedCalendarIds: string[];
  unlinked: string[];
  unlinkedFueling: string[];
  /** fromISO of each reconcile call, and its position relative to getSessions. */
  reconciled: string[];
  order: string[];
}

function makeDeps(
  sessions: CalendarSyncRow[],
  over: Partial<CalendarSyncDeps> = {},
): { deps: CalendarSyncDeps; calls: Calls } {
  const calls: Calls = {
    insert: [],
    insertCalendarIds: [],
    patch: [],
    patchCalendarIds: [],
    markSynced: [],
    markFuelingSynced: [],
    ensured: [],
    removed: [],
    removedCalendarIds: [],
    unlinked: [],
    unlinkedFueling: [],
    reconciled: [],
    recordPushed: [],
    order: [],
  };
  let seq = 0;
  const deps: CalendarSyncDeps = {
    getAccessToken: async () => 'tok',
    ensureMealsCalendar: async () => {
      calls.ensured.push('meals');
      return 'meals-cal';
    },
    ensureTrainingCalendar: async () => {
      calls.ensured.push('training');
      return 'train-cal';
    },
    getSessions: async () => {
      calls.order.push('getSessions');
      return sessions;
    },
    insert: async (_t, c, event) => {
      calls.insert.push(event);
      calls.insertCalendarIds.push(c);
      return { id: `evt-${++seq}` };
    },
    patch: async (_t, c, eventId, event) => {
      calls.patch.push({ eventId, event });
      calls.patchCalendarIds.push(c);
      return { id: eventId };
    },
    markSynced: async (id, eventId) => {
      calls.markSynced.push({ id, eventId });
    },
    recordPushed: async (id, event) => {
      calls.recordPushed.push({ id, eventId: event.id });
    },
    markFuelingSynced: async (id, eventId) => {
      calls.markFuelingSynced.push({ id, eventId });
    },
    unlinkFueling: async (id) => {
      calls.unlinkedFueling.push(id);
    },
    resolveRoutes: async () => [], // no routes by default; overridden per test
    getAdHocRoutes: async () => [],
    getSkipped: async () => [], // nothing skipped by default; overridden per test
    remove: async (_t, c, eventId) => {
      calls.removed.push(eventId);
      calls.removedCalendarIds.push(c);
    },
    unlink: async (id) => {
      calls.unlinked.push(id);
    },
    reconcile: async (fromISO) => {
      calls.reconciled.push(fromISO);
      calls.order.push('reconcile');
      return {
        examined: 3,
        moved: 1,
        skipped: 1,
        distanceChanged: 0,
        contentChanged: 0,
      };
    },
    getFuelingInputs: async () => null, // no reminder by default; overridden per test
    ...over,
  };
  return { deps, calls };
}

describe('syncTrainingCalendar', () => {
  it('ensures both calendars (meals + training)', async () => {
    const { deps, calls } = makeDeps([]);
    const summary = await syncTrainingCalendar({ fromISO: '2026-07-29' }, deps);
    expect(calls.ensured).toEqual(['meals', 'training']);
    expect(summary.calendarId).toBe('train-cal');
    expect(summary.total).toBe(0);
  });

  it('inserts and links unsynced sessions', async () => {
    const { deps, calls } = makeDeps([row({ id: 'a', gcalEventId: null })]);
    const summary = await syncTrainingCalendar({ fromISO: '2026-07-29' }, deps);
    expect(calls.insert).toHaveLength(1);
    expect(calls.patch).toHaveLength(0);
    expect(calls.markSynced).toEqual([{ id: 'a', eventId: 'evt-1' }]);
    expect(summary).toMatchObject({ created: 1, updated: 0, total: 1 });
  });

  it('patches already-linked sessions (idempotent re-sync)', async () => {
    const { deps, calls } = makeDeps([
      row({ id: 'b', gcalEventId: 'evt-existing' }),
    ]);
    const summary = await syncTrainingCalendar({ fromISO: '2026-07-29' }, deps);
    expect(calls.patch).toHaveLength(1);
    expect(calls.insert).toHaveLength(0);
    expect(calls.markSynced).toHaveLength(0); // already linked, nothing to relink
    expect(summary).toMatchObject({ created: 0, updated: 1 });
  });

  // MZY-417: reconcile needs the event as Google returned it after every push,
  // or a changed default slot reads as a hand edit.
  it('snapshots the event Google returned after each insert and patch', async () => {
    const { deps, calls } = makeDeps([
      row({ id: 's-new', gcalEventId: null }),
      row({ id: 's-old', gcalEventId: 'evt-old' }),
    ]);
    await syncTrainingCalendar({ fromISO: '2026-07-29' }, deps);
    expect(calls.recordPushed).toEqual([
      { id: 's-new', eventId: 'evt-1' },
      { id: 's-old', eventId: 'evt-old' },
    ]);
  });

  it('re-inserts when a linked event was deleted on the calendar side (404)', async () => {
    const { deps, calls } = makeDeps([row({ id: 'c', gcalEventId: 'gone' })], {
      patch: async () => {
        throw new GoogleCalendarNotFoundError('404');
      },
    });
    const summary = await syncTrainingCalendar({ fromISO: '2026-07-29' }, deps);
    expect(calls.insert).toHaveLength(1);
    expect(calls.markSynced).toEqual([{ id: 'c', eventId: 'evt-1' }]);
    expect(summary).toMatchObject({ created: 1, updated: 0 });
  });

  it('embeds the suggested route links in a run event description and counts it', async () => {
    const { deps, calls } = makeDeps([row({ id: 'r', gcalEventId: null })], {
      resolveRoutes: async () => [
        {
          mapsUrl: 'https://maps.example/a',
          distanceKm: 8.4,
          elevationGainM: 95,
          label: 'Route 1 · 8.4 km — Tempelhof',
        },
        {
          mapsUrl: 'https://maps.example/b',
          distanceKm: 8.1,
          elevationGainM: 70,
          label: 'Route 2 · 8.1 km — Kreuzberg',
        },
      ],
    });
    const summary = await syncTrainingCalendar({ fromISO: '2026-07-29' }, deps);
    const event = calls.insert[0] as { description: string };
    expect(event.description).toContain('Suggested routes from home');
    expect(event.description).toContain(
      '<a href="https://maps.example/a">Route 1 · 8.4 km — Tempelhof · +95 m · 11 m/km</a>',
    );
    expect(event.description).toContain(
      '<a href="https://maps.example/b">Route 2 · 8.1 km — Kreuzberg · +70 m · 9 m/km</a>',
    );
    expect(summary.routesAttached).toBe(1);
  });

  it('embeds the Vaseline/refueling reminder on a long run when fueling inputs resolve', async () => {
    const { deps, calls } = makeDeps(
      [row({ id: 'r', gcalEventId: null, targetDistanceKm: 21.1 })],
      {
        getFuelingInputs: async () => ({
          paceSPerKm: 360,
          sweatRateLPerH: 0.8,
        }),
      },
    );
    await syncTrainingCalendar({ fromISO: '2026-07-29' }, deps);
    const event = calls.insert[0] as { description: string };
    expect(event.description).toContain('Vaseline');
    expect(event.description).toContain('Suggested refueling');
  });

  it('omits the reminder on a short run even when fueling inputs resolve', async () => {
    const { deps, calls } = makeDeps(
      [row({ id: 'r', gcalEventId: null, targetDistanceKm: 8.5 })],
      {
        getFuelingInputs: async () => ({
          paceSPerKm: 360,
          sweatRateLPerH: 0.8,
        }),
      },
    );
    await syncTrainingCalendar({ fromISO: '2026-07-29' }, deps);
    const event = calls.insert[0] as { description: string };
    expect(event.description).not.toContain('Vaseline');
  });

  it('skips route resolution entirely when routes:false', async () => {
    let called = false;
    const { deps } = makeDeps([row({ id: 'r', gcalEventId: null })], {
      resolveRoutes: async () => {
        called = true;
        return [{ mapsUrl: 'x', distanceKm: 8, elevationGainM: null }];
      },
    });
    const summary = await syncTrainingCalendar(
      { fromISO: '2026-07-29', routes: false },
      deps,
    );
    expect(called).toBe(false);
    expect(summary.routesAttached).toBe(0);
  });

  it('stops attempting routes after an ORS 429, but still syncs every event', async () => {
    let routeCalls = 0;
    const { deps, calls } = makeDeps(
      [
        row({ id: 'r1', gcalEventId: null }),
        row({ id: 'r2', gcalEventId: null }),
        row({ id: 'r3', gcalEventId: null }),
      ],
      {
        resolveRoutes: async () => {
          routeCalls++;
          throw new OrsRateLimitError('429');
        },
      },
    );
    const summary = await syncTrainingCalendar({ fromISO: '2026-07-29' }, deps);
    // First session hits the 429 → short-circuit; no further route attempts.
    expect(routeCalls).toBe(1);
    expect(summary.routesAttached).toBe(0);
    // All three events still synced (degraded to no link).
    expect(calls.insert).toHaveLength(3);
    expect(summary).toMatchObject({ created: 3, total: 3 });
  });

  it('propagates non-404 patch errors', async () => {
    const { deps } = makeDeps([row({ id: 'd', gcalEventId: 'x' })], {
      patch: async () => {
        throw new Error('boom');
      },
    });
    await expect(
      syncTrainingCalendar({ fromISO: '2026-07-29' }, deps),
    ).rejects.toThrow('boom');
  });

  it('deletes the calendar event of a session marked skipped, and unlinks it', async () => {
    const { deps, calls } = makeDeps([], {
      getSkipped: async () => [
        {
          id: 'skipped-1',
          date: '2026-08-23',
          description: 'Lift — Legs',
          gcalEventId: 'evt-legs',
          gcalFuelingEventId: null,
          gcalPushed: null,
          outcome: null,
        },
      ],
    });
    const summary = await syncTrainingCalendar({ fromISO: '2026-08-23' }, deps);
    expect(calls.removed).toEqual(['evt-legs']);
    // The id must be forgotten, else an un-skip would patch a deleted event.
    expect(calls.unlinked).toEqual(['skipped-1']);
    expect(summary.removed).toBe(1);
    // A skipped session is not a synced one — it must not inflate the counts.
    expect(summary).toMatchObject({ created: 0, updated: 0, total: 0 });
  });

  it('reports nothing removed when no session is skipped', async () => {
    const { deps, calls } = makeDeps([row({ id: 'a', gcalEventId: 'evt-a' })]);
    const summary = await syncTrainingCalendar({ fromISO: '2026-07-29' }, deps);
    expect(calls.removed).toEqual([]);
    expect(calls.unlinked).toEqual([]);
    expect(summary.removed).toBe(0);
  });
});

describe('fueling companion event', () => {
  it('creates a fueling event on the Meals calendar for a run at/above the threshold', async () => {
    const { deps, calls } = makeDeps([
      row({ id: 'r', gcalEventId: null, targetDistanceKm: 20 }),
    ]);
    const summary = await syncTrainingCalendar({ fromISO: '2026-07-29' }, deps);
    // insert[0] is the training event, insert[1] the fueling event.
    expect(calls.insert).toHaveLength(2);
    expect(calls.insertCalendarIds).toEqual(['train-cal', 'meals-cal']);
    const fuelingEvent = calls.insert[1] as {
      summary: string;
      description: string;
    };
    expect(fuelingEvent.summary).toBe('🧃 Fueling — 3 bottles');
    expect(fuelingEvent.description).toContain('Standard Fueling Solution ×3');
    expect(calls.markFuelingSynced).toEqual([{ id: 'r', eventId: 'evt-2' }]);
    expect(summary.fuelingCreated).toBe(1);
    expect(summary.fuelingUpdated).toBe(0);
  });

  it('places the fueling event at the midpoint of the run', async () => {
    const { deps, calls } = makeDeps([
      row({ id: 'r', gcalEventId: null, targetDistanceKm: 20 }),
    ]);
    await syncTrainingCalendar({ fromISO: '2026-07-29' }, deps);
    const fuelingEvent = calls.insert[1] as {
      start: { dateTime: string };
      end: { dateTime: string };
    };
    // 20 km at the 'easy' sizing pace (6.0 min/km) → 120 min, 19:00 start →
    // midpoint 20:00.
    expect(fuelingEvent.start.dateTime).toContain('T20:00:00');
  });

  it('omits the fueling event for a run below the threshold', async () => {
    const { deps, calls } = makeDeps([
      row({ id: 'r', gcalEventId: null, targetDistanceKm: 8.5 }),
    ]);
    const summary = await syncTrainingCalendar({ fromISO: '2026-07-29' }, deps);
    expect(calls.insert).toHaveLength(1); // training event only
    expect(summary.fuelingCreated).toBe(0);
  });

  it('patches an already-linked fueling event (idempotent re-sync)', async () => {
    const { deps, calls } = makeDeps([
      row({
        id: 'r',
        gcalEventId: 'evt-train',
        gcalFuelingEventId: 'evt-fuel',
        targetDistanceKm: 20,
      }),
    ]);
    const summary = await syncTrainingCalendar({ fromISO: '2026-07-29' }, deps);
    expect(calls.patch).toHaveLength(2);
    expect(calls.patchCalendarIds).toEqual(['train-cal', 'meals-cal']);
    expect(calls.insert).toHaveLength(0);
    expect(summary.fuelingUpdated).toBe(1);
    expect(summary.fuelingCreated).toBe(0);
  });

  it('removes a stale fueling event when a program edit drops the run below the threshold', async () => {
    const { deps, calls } = makeDeps([
      row({
        id: 'r',
        gcalEventId: 'evt-train',
        gcalFuelingEventId: 'evt-fuel',
        targetDistanceKm: 8, // edited down below LONG_RUN_REMINDER_KM
      }),
    ]);
    const summary = await syncTrainingCalendar({ fromISO: '2026-07-29' }, deps);
    expect(calls.removed).toEqual(['evt-fuel']);
    expect(calls.removedCalendarIds).toEqual(['meals-cal']);
    expect(calls.unlinkedFueling).toEqual(['r']);
    expect(summary.removed).toBe(1);
    expect(summary.fuelingCreated).toBe(0);
    expect(summary.fuelingUpdated).toBe(0);
  });

  it("removes a skipped session's fueling event too, on the Meals calendar", async () => {
    const { deps, calls } = makeDeps([], {
      getSkipped: async () => [
        {
          id: 'skipped-1',
          date: '2026-08-23',
          description: 'Long run',
          gcalEventId: 'evt-run',
          gcalFuelingEventId: 'evt-fuel',
        },
      ],
    });
    const summary = await syncTrainingCalendar({ fromISO: '2026-08-23' }, deps);
    expect(calls.removed).toEqual(['evt-run', 'evt-fuel']);
    expect(calls.removedCalendarIds).toEqual(['train-cal', 'meals-cal']);
    expect(calls.unlinked).toEqual(['skipped-1']);
    expect(calls.unlinkedFueling).toEqual(['skipped-1']);
    expect(summary.removed).toBe(2);
  });
});

// Deleting an event the athlete already removed by hand must not fail the sync:
// Google answers 410 Gone (not 404), and the end state is the one we wanted.
describe('deleteEvent tolerance', () => {
  it('treats an already-deleted event as success', async () => {
    const { deleteEvent, GoogleCalendarNotFoundError: NotFound } =
      await import('@/services/googleCalendar/client');
    for (const status of [404, 410]) {
      const fetchMock = jest
        .fn()
        .mockResolvedValue(new Response('gone', { status }));
      const original = global.fetch;
      global.fetch = fetchMock as unknown as typeof fetch;
      try {
        await expect(deleteEvent('tok', 'cal', 'evt')).resolves.toBeUndefined();
      } finally {
        global.fetch = original;
      }
    }
    expect(NotFound).toBeDefined();
  });

  it('does not reconcile unless asked', async () => {
    const { deps, calls } = makeDeps([row({ gcalEventId: 'evt-a' })]);
    const summary = await syncTrainingCalendar({ fromISO: '2026-07-29' }, deps);
    expect(calls.reconciled).toEqual([]);
    expect(summary.reconciled).toBeNull();
  });

  it('reconciles BEFORE reading sessions when asked', async () => {
    // Ordering is the whole point: reading sessions first would push Agon's stale
    // view over the edit the reconcile pass is about to import.
    const { deps, calls } = makeDeps([row({ gcalEventId: 'evt-a' })]);
    const summary = await syncTrainingCalendar(
      { fromISO: '2026-07-29', reconcile: true },
      deps,
    );
    expect(calls.reconciled).toEqual(['2026-07-29']);
    expect(calls.order).toEqual(['reconcile', 'getSessions']);
    expect(summary.reconciled).toMatchObject({ moved: 1, skipped: 1 });
  });
  it('defaults the window to a few days back, so a run moved on its own day still reconciles', async () => {
    // Regression: a today-onward floor never read a run dragged on the day it
    // happened, leaving its "🧃 Fueling" event at the old slot.
    const { deps, calls } = makeDeps([row({ gcalEventId: 'evt-a' })]);
    await syncTrainingCalendar({ reconcile: true }, deps);
    expect(calls.reconciled).toEqual([defaultSyncFromISO()]);
    expect(SYNC_LOOKBACK_DAYS).toBeGreaterThan(0);
  });

  it('computes the default floor SYNC_LOOKBACK_DAYS before now', () => {
    expect(defaultSyncFromISO(new Date('2026-10-05T08:00:00Z'))).toBe(
      '2026-10-02',
    );
  });
});
