import { ensureRoutesForSession } from '@/services/googleCalendar/routeForSession';
import type { RouteForSessionDeps } from '@/services/googleCalendar/routeForSession';
import type { CalendarSyncRow } from '@/services/plannedSessions';
import type { SuggestRoutesInput } from '@/services/routing';

// Reuse-else-generate-diverse orchestration with injected deps — no routing API,
// no DB.

function run(over: Partial<CalendarSyncRow> = {}): CalendarSyncRow {
  return {
    id: 'ps-1',
    date: '2026-07-29',
    block: 3,
    week: 19,
    sessionKind: 'run',
    description: 'Easy run',
    targetDistanceKm: 10,
    targetHrCap: 156,
    targetSessionType: 'easy',
    gcalEventId: null,
    gcalFuelingEventId: null,
    ...over,
  };
}

function deps(over: Partial<RouteForSessionDeps>): RouteForSessionDeps {
  return {
    getAttached: async () => [],
    clearAttached: async () => {},
    generate: async () => {
      throw new Error('generate should not be called');
    },
    describeVia: async () => [],
    save: async () => {
      throw new Error('save should not be called');
    },
    attach: async () => {
      throw new Error('attach should not be called');
    },
    home: () => null,
    work: () => null,
    countCrossings: async () => {
      throw new Error('countCrossings should not be called');
    },
    timeTrialVias: () => [],
    ...over,
  };
}

describe('ensureRoutesForSession', () => {
  it('returns [] for non-run, non-bike sessions', async () => {
    expect(
      await ensureRoutesForSession(run({ sessionKind: 'lift' }), deps({})),
    ).toEqual([]);
  });

  it('returns [] for a run with no target distance', async () => {
    expect(
      await ensureRoutesForSession(run({ targetDistanceKm: null }), deps({})),
    ).toEqual([]);
  });

  it('generates a cycling-regular loop for a bike session (inferred distance)', async () => {
    const d = deps({
      getAttached: async () => [],
      clearAttached: async () => {},
      generate: async (input) => {
        expect(input.profile).toBe('cycling-regular');
        // 45 min assumed duration × 20 km/h assumed easy pace = 15 km.
        expect(input.targetKm).toBe(15);
        expect(input.diverse).toBe(true);
        return {
          start: { lat: 0, lng: 0, label: 'home' },
          targetKm: input.targetKm,
          profile: 'cycling-regular',
          candidates: [
            {
              seed: 1,
              distanceM: 15100,
              elevationGainM: 40,
              elevationGainPerKmM: 40 / 15.1,
              distanceErrorM: 100,
              coordinates: [[0, 0]],
              provider: 'ors',
              direction: 'N',
            },
          ],
        };
      },
      describeVia: async () => ['Grunewald'],
      save: async (result, extras) => ({
        batchId: 'b-bike',
        suggestions: result.candidates.map((c, i) => ({
          id: `sug-bike-${i + 1}`,
          batchId: 'b-bike',
          rank: i + 1,
          seed: c.seed,
          distanceM: c.distanceM,
          elevationGainM: c.elevationGainM,
          provider: c.provider,
          gpx: '<gpx/>',
          mapsUrl: `bike-${i + 1}`,
          direction: c.direction ?? null,
          viaLabel: extras?.labels?.[i] ?? null,
          kind: 'auto',
          plannedSessionId: null,
        })),
      }),
      attach: async () => ({ plannedDate: '2026-09-08', sessionKind: 'bike' }),
    });
    const infos = await ensureRoutesForSession(
      run({ sessionKind: 'bike', targetDistanceKm: null }),
      d,
    );
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ mapsUrl: 'bike-1', distanceKm: 15.1 });
  });

  it('sizes a bike loop to a hand-set distance (MZY-262)', async () => {
    let requested: number | undefined;
    const d = deps({
      getAttached: async () => [],
      clearAttached: async () => {},
      generate: async (input) => {
        requested = input.targetKm;
        return {
          start: { lat: 0, lng: 0, label: 'home' },
          targetKm: input.targetKm,
          profile: 'cycling-regular',
          candidates: [],
        };
      },
    });
    await ensureRoutesForSession(
      run({ sessionKind: 'bike', targetDistanceKm: 16.3 }),
      d,
    );
    expect(requested).toBe(16.3);
  });

  it('adds no auto loops when the detail carries a hand-written route (MZY-262)', async () => {
    const d = deps({
      getAttached: async () => {
        throw new Error('must not look up routes');
      },
    });
    expect(
      await ensureRoutesForSession(
        run({
          sessionKind: 'bike',
          targetDistanceKm: null,
          detail: 'One-way\n• <a href="https://maps.example/r">Route 1</a>',
        }),
        d,
      ),
    ).toEqual([]);
  });

  it('reuses already-attached bike routes without hitting the routing API', async () => {
    const d = deps({
      getAttached: async () => [
        {
          mapsUrl: 'b1',
          distanceM: 15000,
          elevationGainM: 40,
          direction: 'N',
          viaLabel: null,
          kind: 'auto',
        },
        {
          mapsUrl: 'b2',
          distanceM: 15200,
          elevationGainM: 30,
          direction: 'E',
          viaLabel: null,
          kind: 'auto',
        },
        {
          mapsUrl: 'b3',
          distanceM: 14900,
          elevationGainM: 20,
          direction: 'S',
          viaLabel: null,
          kind: 'auto',
        },
      ],
    });
    const infos = await ensureRoutesForSession(run({ sessionKind: 'bike' }), d);
    expect(infos).toHaveLength(3);
    expect(infos[0]).toMatchObject({ mapsUrl: 'b1' });
  });

  it('reuses an already-attached set of 3 without hitting the routing API', async () => {
    const d = deps({
      getAttached: async () => [
        {
          mapsUrl: 'u1',
          distanceM: 9800,
          elevationGainM: 120,
          direction: 'N',
          viaLabel: 'Route 1 · 9.8 km — A',
          kind: 'auto',
        },
        {
          mapsUrl: 'u2',
          distanceM: 10100,
          elevationGainM: 90,
          direction: 'E',
          viaLabel: 'Route 2 · 10.1 km — B',
          kind: 'auto',
        },
        {
          mapsUrl: 'u3',
          distanceM: 10000,
          elevationGainM: 60,
          direction: 'S',
          viaLabel: 'Route 3 · 10.0 km — C',
          kind: 'auto',
        },
      ],
    });
    const infos = await ensureRoutesForSession(run(), d);
    expect(infos).toHaveLength(3);
    expect(infos[0]).toMatchObject({
      mapsUrl: 'u1',
      distanceKm: 9.8,
      label: 'Route 1 · 9.8 km — A',
    });
  });

  it('regenerates a full set sized for a target the athlete has since hand-edited', async () => {
    const stale = (mapsUrl: string) => ({
      mapsUrl,
      distanceM: 18000,
      elevationGainM: 50,
      direction: null,
      viaLabel: null,
      kind: 'auto' as const,
      requestedKm: 18,
    });
    const cleared: string[] = [];
    let generatedFor: number | null = null;
    const d = deps({
      getAttached: async () => [stale('a'), stale('b'), stale('c')],
      clearAttached: async (id) => {
        cleared.push(id);
      },
      generate: async (input) => {
        generatedFor = input.targetKm;
        return {
          start: { lat: 0, lng: 0, label: 'home' },
          targetKm: input.targetKm,
          profile: 'foot-walking' as const,
          candidates: [],
        };
      },
    });
    // Calendar title edited 18 → 15 km; the resolved target is now 15.
    await ensureRoutesForSession(run({ targetDistanceKm: 15 }), d);
    expect(generatedFor).toBe(15);
    // Nothing usable came back, so the old set is left attached, not wiped.
    expect(cleared).toEqual([]);
  });

  it('keeps the old set attached when regeneration fails (e.g. ORS quota)', async () => {
    const cleared: string[] = [];
    const d = deps({
      getAttached: async () => [],
      clearAttached: async (id) => {
        cleared.push(id);
      },
      generate: async () => {
        throw new Error('openrouteservice: 403 Quota exceeded');
      },
    });
    await expect(ensureRoutesForSession(run(), d)).rejects.toThrow('Quota');
    expect(cleared).toEqual([]);
  });

  it('reuses a full set whose recorded request matches the current target', async () => {
    const fresh = (mapsUrl: string) => ({
      mapsUrl,
      distanceM: 10050,
      elevationGainM: 50,
      direction: null,
      viaLabel: null,
      kind: 'auto' as const,
      requestedKm: 10,
    });
    const d = deps({
      getAttached: async () => [fresh('a'), fresh('b'), fresh('c')],
    });
    const infos = await ensureRoutesForSession(run(), d);
    expect(infos.map((i) => i.mapsUrl)).toEqual(['a', 'b', 'c']);
  });

  it('regenerates a diverse set (clears stale, describes, saves, attaches) when fewer than 3 exist', async () => {
    const cleared: string[] = [];
    const attached: string[] = [];
    const d = deps({
      getAttached: async () => [
        // an old single route (pre-diversity) → below the desired 3, regenerate
        {
          mapsUrl: 'old',
          distanceM: 10000,
          elevationGainM: 100,
          direction: null,
          viaLabel: null,
          kind: 'auto',
        },
      ],
      clearAttached: async (id) => {
        cleared.push(id);
      },
      generate: async (input) => {
        expect(input.diverse).toBe(true);
        expect(input.keep).toBe(3);
        return {
          start: { lat: 0, lng: 0, label: 'home' },
          targetKm: 10,
          profile: 'foot-walking' as const,
          candidates: [
            {
              seed: 1,
              distanceM: 10100,
              elevationGainM: 80,
              elevationGainPerKmM: 80 / 10.1,
              distanceErrorM: 100,
              coordinates: [[0, 0]],
              provider: 'ors',
              direction: 'N',
            },
            {
              seed: 3,
              distanceM: 9900,
              elevationGainM: 60,
              elevationGainPerKmM: 60 / 9.9,
              distanceErrorM: 100,
              coordinates: [[0, 0]],
              provider: 'ors',
              direction: 'E',
            },
            {
              seed: 5,
              distanceM: 10200,
              elevationGainM: 90,
              elevationGainPerKmM: 90 / 10.2,
              distanceErrorM: 200,
              coordinates: [[0, 0]],
              provider: 'ors',
              direction: 'S',
            },
          ],
        };
      },
      describeVia: async () => ['Tempelhof', 'Schöneberg'],
      save: async (result, extras) => ({
        batchId: 'b1',
        suggestions: result.candidates.map((c, i) => ({
          id: `sug-${i + 1}`,
          batchId: 'b1',
          rank: i + 1,
          seed: c.seed,
          distanceM: c.distanceM,
          elevationGainM: c.elevationGainM,
          provider: c.provider,
          gpx: '<gpx/>',
          mapsUrl: `new-${i + 1}`,
          direction: c.direction ?? null,
          viaLabel: extras?.labels?.[i] ?? null,
          kind: 'auto',
          plannedSessionId: null,
        })),
      }),
      attach: async (suggestionId, plannedSessionId) => {
        attached.push(`${suggestionId}->${plannedSessionId}`);
        return { plannedDate: '2026-07-29', sessionKind: 'run' };
      },
    });
    const infos = await ensureRoutesForSession(run(), d);
    expect(cleared).toEqual(['ps-1']); // stale cleared first
    expect(infos).toHaveLength(3);
    // via-based label built from the described areas
    expect(infos[0]!.label).toBe(
      'Route 1 · 10.1 km — Tempelhof and Schöneberg',
    );
    expect(attached).toEqual(['sug-1->ps-1', 'sug-2->ps-1', 'sug-3->ps-1']);
  });

  describe('commute rides', () => {
    const HOME = { lat: 52.44, lng: 13.2 };
    const WORK = { lat: 52.47, lng: 13.28 };

    function candidate(distanceM: number, seed: number) {
      return {
        seed,
        distanceM,
        elevationGainM: 10,
        elevationGainPerKmM: 1,
        distanceErrorM: 0,
        coordinates: [[0, 0]] as [number, number][],
        provider: 'ors',
        direction: 'NE',
      };
    }

    function commuteDeps(
      calls: SuggestRoutesInput[],
      variants: number[],
      over: Partial<RouteForSessionDeps> = {},
    ): RouteForSessionDeps {
      return deps({
        home: () => HOME,
        work: () => WORK,
        generate: async (input) => {
          calls.push(input);
          const direct = input.keep === 1;
          return {
            start: { ...HOME, label: 'start' },
            targetKm: input.targetKm,
            profile: 'cycling-regular',
            oneWay: true,
            candidates: direct
              ? [candidate(8000, 0)]
              : variants.map((m, i) => candidate(m, i + 1)),
          };
        },
        save: async (result, extras) => ({
          batchId: 'b-c',
          suggestions: result.candidates.map((c, i) => ({
            id: `sug-c-${i + 1}`,
            batchId: 'b-c',
            rank: i + 1,
            seed: c.seed,
            distanceM: c.distanceM,
            elevationGainM: c.elevationGainM,
            provider: c.provider,
            gpx: '<gpx/>',
            mapsUrl: `c-${i + 1}`,
            direction: c.direction ?? null,
            viaLabel: extras?.labels?.[i] ?? null,
            kind: 'auto',
            plannedSessionId: null,
          })),
        }),
        attach: async () => ({
          plannedDate: '2026-10-20',
          sessionKind: 'bike',
        }),
        ...over,
      });
    }

    const commute = (targetSessionType: string) =>
      run({ sessionKind: 'bike', targetDistanceKm: null, targetSessionType });

    it('rides home → work in the morning: direct first, then near-direct variants', async () => {
      const calls: SuggestRoutesInput[] = [];
      const infos = await ensureRoutesForSession(
        commute('commute_to_work'),
        commuteDeps(calls, [8900, 9000]),
      );
      expect(calls).toHaveLength(2);
      for (const c of calls) {
        expect(c.start).toEqual({ coord: HOME });
        expect(c.finishNear).toEqual({ coord: WORK });
        expect(c.profile).toBe('cycling-regular');
      }
      expect(calls[1]!.targetKm).toBeCloseTo(8 * 1.12);
      expect(infos.map((i) => i.distanceKm)).toEqual([8, 8.9, 9]);
      expect(infos[0]!.label).toMatch(/one-way.*\(fastest\)$/);
    });

    it('rides work → home in the evening with more room to wander', async () => {
      const calls: SuggestRoutesInput[] = [];
      await ensureRoutesForSession(
        commute('commute_home'),
        commuteDeps(calls, [12000, 12100]),
      );
      expect(calls[0]!.start).toEqual({ coord: WORK });
      expect(calls[0]!.finishNear).toEqual({ coord: HOME });
      expect(calls[1]!.targetKm).toBeCloseTo(8 * 1.5);
    });

    it('drops a variant that is just the direct route again', async () => {
      const infos = await ensureRoutesForSession(
        commute('commute_to_work'),
        commuteDeps([], [8050, 9000]),
      );
      expect(infos.map((i) => i.distanceKm)).toEqual([8, 9]);
    });

    it('returns [] without generating when the workplace is not configured', async () => {
      const calls: SuggestRoutesInput[] = [];
      const infos = await ensureRoutesForSession(
        commute('commute_to_work'),
        commuteDeps(calls, [9000], { work: () => null }),
      );
      expect(infos).toEqual([]);
      expect(calls).toEqual([]);
    });

    it('reuses an attached set instead of regenerating', async () => {
      const calls: SuggestRoutesInput[] = [];
      const infos = await ensureRoutesForSession(
        commute('commute_home'),
        commuteDeps(calls, [9000], {
          getAttached: async () => [
            {
              id: 'r1',
              mapsUrl: 'kept-1',
              distanceM: 8000,
              elevationGainM: 5,
              direction: 'NE',
              viaLabel: 'Route 1 · 8.0 km one-way (fastest)',
              requestedKm: 0.1,
            } as never,
          ],
        }),
      );
      expect(calls).toEqual([]);
      expect(infos.map((i) => i.mapsUrl)).toEqual(['kept-1']);
    });
  });

  describe('time trials', () => {
    const tt = () =>
      run({
        targetDistanceKm: 5,
        targetSessionType: 'time_trial',
        targetHrCap: null,
      });

    function loop(seed: number, distanceM: number) {
      return {
        seed,
        distanceM,
        elevationGainM: 20,
        elevationGainPerKmM: 4,
        distanceErrorM: Math.abs(distanceM - 5000),
        coordinates: [[seed, seed]] as number[][],
        provider: 'ors',
        direction: 'N',
      };
    }

    // Traffic lights per candidate, keyed by seed (coordinates carry the seed).
    function ttDeps(
      signalsBySeed: Record<number, number>,
      calls: SuggestRoutesInput[],
      over: Partial<RouteForSessionDeps> = {},
    ): RouteForSessionDeps {
      return deps({
        timeTrialVias: () => ['Volkspark'],
        generate: async (input) => {
          calls.push(input);
          const fromVia = (input.through?.length ?? 0) > 0;
          return {
            start: { lat: 0, lng: 0, label: 'home' },
            targetKm: input.targetKm,
            profile: 'foot-walking',
            candidates: fromVia
              ? [loop(11, 5100), loop(12, 5050)]
              : [loop(1, 5000), loop(2, 4900), loop(3, 5200)],
          };
        },
        countCrossings: async (coords) => {
          const seed = (coords as number[][])[0]![0]!;
          return {
            trafficSignals: signalsBySeed[seed] ?? 50,
            plainCrossings: 10,
          };
        },
        save: async (result, extras) => ({
          batchId: 'b-tt',
          suggestions: result.candidates.map((c, i) => ({
            id: `sug-tt-${c.seed}`,
            batchId: 'b-tt',
            rank: i + 1,
            seed: c.seed,
            distanceM: c.distanceM,
            elevationGainM: c.elevationGainM,
            provider: c.provider,
            gpx: '<gpx/>',
            mapsUrl: `tt-${c.seed}`,
            direction: c.direction ?? null,
            viaLabel: extras?.labels?.[i] ?? null,
            kind: 'auto',
            plannedSessionId: null,
          })),
        }),
        attach: async () => ({ plannedDate: '2026-10-21', sessionKind: 'run' }),
        ...over,
      });
    }

    it('keeps exactly one route: the fewest traffic lights across home and via loops', async () => {
      const calls: SuggestRoutesInput[] = [];
      const infos = await ensureRoutesForSession(
        tt(),
        ttDeps({ 1: 40, 2: 30, 3: 45, 11: 12, 12: 9 }, calls),
      );
      expect(infos).toHaveLength(1);
      expect(infos[0]!.mapsUrl).toBe('tt-12');
      expect(infos[0]!.label).toMatch(/9 traffic lights, 10 other crossings$/);
      expect(calls.map((c) => c.through ?? null)).toEqual([
        null,
        [{ place: 'Volkspark' }],
      ]);
    });

    it('still picks from the home loops when a via fails to route', async () => {
      const calls: SuggestRoutesInput[] = [];
      const base = ttDeps({ 1: 40, 2: 30, 3: 45 }, calls);
      const infos = await ensureRoutesForSession(
        tt(),
        ttDeps({ 1: 40, 2: 30, 3: 45 }, calls, {
          generate: async (input) => {
            if (input.through) throw new Error('no route through via');
            return base.generate(input);
          },
        }),
      );
      expect(infos.map((i) => i.mapsUrl)).toEqual(['tt-2']);
      expect(infos[0]!.label).toMatch(/run 100 m past the finish/);
    });

    it('reuses the one attached route while it fits the target', async () => {
      const calls: SuggestRoutesInput[] = [];
      const infos = await ensureRoutesForSession(
        tt(),
        ttDeps({}, calls, {
          getAttached: async () => [
            {
              id: 'r',
              mapsUrl: 'kept',
              distanceM: 5000,
              elevationGainM: 10,
              direction: 'N',
              viaLabel: 'Route 1',
              requestedKm: 5,
            } as never,
          ],
        }),
      );
      expect(calls).toEqual([]);
      expect(infos.map((i) => i.mapsUrl)).toEqual(['kept']);
    });

    it('replaces an old three-route set with a single route', async () => {
      const calls: SuggestRoutesInput[] = [];
      let cleared = false;
      const old = {
        id: 'r',
        mapsUrl: 'old',
        distanceM: 4800,
        elevationGainM: 10,
        direction: 'N',
        viaLabel: 'x',
        requestedKm: 5,
      } as never;
      const infos = await ensureRoutesForSession(
        tt(),
        ttDeps({ 1: 5 }, calls, {
          getAttached: async () => [old, old, old],
          clearAttached: async () => {
            cleared = true;
          },
        }),
      );
      expect(cleared).toBe(true);
      expect(infos.map((i) => i.mapsUrl)).toEqual(['tt-1']);
    });
  });
});
