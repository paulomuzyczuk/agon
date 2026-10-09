import {
  reconcileFromCalendar,
  type ReconcileDeps,
} from '@/services/googleCalendar/reconcile';
import type { CalendarSyncRow } from '@/services/plannedSessions';

// Reconcile orchestration with injected seams — no Google, no DB. Verifies that
// calendar edits land in the overlay and that a dry run writes nothing.

function row(over: Partial<CalendarSyncRow> = {}): CalendarSyncRow {
  return {
    id: 'sess-1',
    date: '2026-08-22',
    block: 3,
    week: 22,
    sessionKind: 'run',
    description: 'Long run',
    targetDistanceKm: 19.4,
    targetHrCap: 158,
    targetSessionType: 'long',
    gcalEventId: 'evt-1',
    gcalFuelingEventId: null,
    startTime: null, // → default slot, runs at 12:00
    startTimePriority: null,
    startTimeReason: null,
    ...over,
  };
}

interface Calls {
  moves: { id: string; date?: string }[];
  skips: string[];
  times: { id: string; startTime: string }[];
  distances: { id: string; targetDistanceKm: number }[];
  contents: { id: string; description?: string; detail?: string }[];
}

function makeDeps(
  sessions: CalendarSyncRow[],
  events: {
    id: string;
    status?: string;
    start?: { dateTime?: string };
    summary?: string;
    description?: string;
  }[],
): { deps: ReconcileDeps; calls: Calls } {
  const calls: Calls = {
    moves: [],
    skips: [],
    times: [],
    distances: [],
    contents: [],
  };
  const deps: ReconcileDeps = {
    getAccessToken: async () => 'tok',
    ensureTrainingCalendar: async () => 'cal',
    // Mirrors getLinkedSessions' window: resolved date in range OR event in range.
    getSessions: async (fromISO, eventIds) =>
      sessions.filter(
        (s) =>
          s.date >= fromISO ||
          (s.gcalEventId !== null && eventIds.includes(s.gcalEventId)),
      ),
    fetchEvents: async () => events,
    recordMove: async (id, patch) => {
      calls.moves.push({ id, date: patch.date });
    },
    recordSkip: async (id) => {
      calls.skips.push(id);
    },
    recordTime: async (id, startTime) => {
      calls.times.push({ id, startTime });
    },
    recordDistance: async (id, targetDistanceKm) => {
      calls.distances.push({ id, targetDistanceKm });
    },
    recordContent: async (id, patch) => {
      calls.contents.push({ id, ...patch });
    },
  };
  return { deps, calls };
}

describe('reconcileFromCalendar', () => {
  it('writes nothing when every event is where Agon put it', async () => {
    const { deps, calls } = makeDeps(
      [row()],
      [{ id: 'evt-1', start: { dateTime: '2026-08-22T12:00:00+02:00' } }],
    );
    const summary = await reconcileFromCalendar(
      { fromISO: '2026-08-22' },
      deps,
    );
    expect(summary).toMatchObject({ examined: 1, moved: 0, skipped: 0 });
    expect(calls.moves).toEqual([]);
  });

  it('records a dragged event as a date + time override', async () => {
    const { deps, calls } = makeDeps(
      [row()],
      [{ id: 'evt-1', start: { dateTime: '2026-08-23T17:30:00+02:00' } }],
    );
    const summary = await reconcileFromCalendar(
      { fromISO: '2026-08-22' },
      deps,
    );
    expect(summary.moved).toBe(1);
    expect(calls.moves).toEqual([{ id: 'sess-1', date: '2026-08-23' }]);
    expect(calls.times).toEqual([{ id: 'sess-1', startTime: '17:30' }]);
  });

  it('reconciles a session dragged forward into the window from before it (MZY-259)', async () => {
    // Agon still has it on the 29th; the athlete dragged it to the 30th and
    // edited its distance. Syncing --from the 30th must still see both edits.
    const { deps, calls } = makeDeps(
      [
        row({
          date: '2026-09-29',
          targetDistanceKm: 9,
          description: 'Easy run',
        }),
      ],
      [
        {
          id: 'evt-1',
          start: { dateTime: '2026-09-30T22:00:00+02:00' },
          summary: '🏃 Easy run — 12 km',
        },
      ],
    );
    const summary = await reconcileFromCalendar(
      { fromISO: '2026-09-30' },
      deps,
    );
    expect(summary).toMatchObject({
      examined: 1,
      moved: 1,
      distanceChanged: 1,
    });
    expect(calls.moves).toEqual([{ id: 'sess-1', date: '2026-09-30' }]);
    expect(calls.distances).toEqual([{ id: 'sess-1', targetDistanceKm: 12 }]);
    expect(calls.skips).toEqual([]);
  });

  it("persists a ride's hand-edited title and detail (MZY-262)", async () => {
    const { deps, calls } = makeDeps(
      [
        row({
          date: '2026-10-04',
          sessionKind: 'bike',
          description: 'Easy bike ride',
          targetDistanceKm: null,
          targetSessionType: null,
          startTime: '11:00',
          startTimePriority: 'strong',
        }),
      ],
      [
        {
          id: 'evt-1',
          start: { dateTime: '2026-10-04T11:00:00+02:00' },
          summary: '🚴 Bike ride — Home → RSO — 16,3 km',
          description:
            'Block 4 · Week 28<br>One-way to RSO<br><br>Planned by Agon',
        },
      ],
    );
    const summary = await reconcileFromCalendar(
      { fromISO: '2026-10-01' },
      deps,
    );
    expect(summary).toMatchObject({ distanceChanged: 1, contentChanged: 1 });
    expect(calls.distances).toEqual([{ id: 'sess-1', targetDistanceKm: 16.3 }]);
    expect(calls.contents).toEqual([
      {
        id: 'sess-1',
        description: 'Bike ride — Home → RSO',
        detail: 'One-way to RSO',
      },
    ]);
  });

  it('rewrites the note on a second, time-only move — the last time wins', async () => {
    // Already moved to the 23rd at 14:00; now dragged later the same day.
    const notes: { id: string; date?: string; note: string }[] = [];
    const { deps, calls } = makeDeps(
      [
        row({
          date: '2026-08-23',
          startTime: '14:00',
          startTimePriority: 'strong',
        }),
      ],
      [{ id: 'evt-1', start: { dateTime: '2026-08-23T23:15:00+02:00' } }],
    );
    deps.recordMove = async (id, patch) => {
      notes.push({ id, ...patch });
    };
    const summary = await reconcileFromCalendar(
      { fromISO: '2026-08-22' },
      deps,
    );
    expect(summary.moved).toBe(1);
    expect(calls.times).toEqual([{ id: 'sess-1', startTime: '23:15' }]);
    // No date in the patch (it didn't change), but the note now names 23:15.
    expect(notes).toEqual([
      { id: 'sess-1', note: 'moved to 23:15 in Google Calendar' },
    ]);
  });

  it('compares against a strong start time, not the default slot', async () => {
    const { deps, calls } = makeDeps(
      [row({ startTime: '17:30', startTimePriority: 'strong' })],
      [{ id: 'evt-1', start: { dateTime: '2026-08-22T17:30:00+02:00' } }],
    );
    const summary = await reconcileFromCalendar(
      { fromISO: '2026-08-22' },
      deps,
    );
    expect(summary.moved).toBe(0);
    expect(calls.times).toEqual([]);
  });

  it('marks a session skipped when its event is gone', async () => {
    const { deps, calls } = makeDeps([row()], []);
    const summary = await reconcileFromCalendar(
      { fromISO: '2026-08-22' },
      deps,
    );
    expect(summary.skipped).toBe(1);
    expect(calls.skips).toEqual(['sess-1']);
    expect(calls.moves).toEqual([]);
  });

  it('persists a hand-edited title distance as a calendar-sourced adjustment', async () => {
    const { deps, calls } = makeDeps(
      [row({ description: 'Long easy run', targetDistanceKm: 17 })],
      [
        {
          id: 'evt-1',
          start: { dateTime: '2026-08-22T12:00:00+02:00' },
          summary: '🏃 Long easy run — 12 km',
        },
      ],
    );
    const summary = await reconcileFromCalendar(
      { fromISO: '2026-08-22' },
      deps,
    );
    expect(summary.distanceChanged).toBe(1);
    expect(summary.moved).toBe(0); // distance-only edit is not a date/time move
    expect(calls.distances).toEqual([{ id: 'sess-1', targetDistanceKm: 12 }]);
  });

  it('does not record a distance edit that matches the resolved value', async () => {
    const { deps, calls } = makeDeps(
      [row({ description: 'Long easy run', targetDistanceKm: 17 })],
      [
        {
          id: 'evt-1',
          start: { dateTime: '2026-08-22T12:00:00+02:00' },
          summary: '🏃 Long easy run — 17 km',
        },
      ],
    );
    const summary = await reconcileFromCalendar(
      { fromISO: '2026-08-22' },
      deps,
    );
    expect(summary.distanceChanged).toBe(0);
    expect(calls.distances).toEqual([]);
  });

  it('writes nothing on a dry run but still reports what would change', async () => {
    const { deps, calls } = makeDeps(
      [row()],
      [{ id: 'evt-1', start: { dateTime: '2026-08-25T12:00:00+02:00' } }],
    );
    const summary = await reconcileFromCalendar(
      { fromISO: '2026-08-22', dryRun: true },
      deps,
    );
    expect(summary.moved).toBe(1);
    expect(calls.moves).toEqual([]);
    expect(calls.times).toEqual([]);
  });
});
