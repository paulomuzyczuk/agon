import { expandCommuteRides, commuteLegOf } from '@/lib/training/commutes';

// Commute ride expansion — pure, no DB, no clock.

describe('expandCommuteRides', () => {
  // 2026-10-13 is a Tuesday, 2026-10-15 a Thursday.
  const window = { weekdays: [2, 4], from: '2026-10-12', until: '2026-10-18' };

  it('emits a to-work and a home leg on each commute weekday only', () => {
    const rides = expandCommuteRides(window);
    expect(rides.map((r) => r.planKey)).toEqual([
      '2026-10-13:bike:to-work',
      '2026-10-13:bike:home',
      '2026-10-15:bike:to-work',
      '2026-10-15:bike:home',
    ]);
    expect(rides.every((r) => r.sessionKind === 'bike')).toBe(true);
    expect(rides.map((r) => r.targetSessionType)).toEqual([
      'commute_to_work',
      'commute_home',
      'commute_to_work',
      'commute_home',
    ]);
  });

  it('keeps commutes out of the program: no block, week or target distance', () => {
    const [ride] = expandCommuteRides(window);
    expect(ride).toMatchObject({
      block: null,
      week: null,
      targetDistanceKm: null,
      targetHrCap: null,
    });
  });

  it('includes both window ends', () => {
    const rides = expandCommuteRides({
      weekdays: [2],
      from: '2026-10-13',
      until: '2026-10-20',
    });
    expect(rides.map((r) => r.dateISO)).toEqual([
      '2026-10-13',
      '2026-10-13',
      '2026-10-20',
      '2026-10-20',
    ]);
  });

  it('treats ISO weekday 7 as Sunday', () => {
    const rides = expandCommuteRides({
      weekdays: [7],
      from: '2026-10-12',
      until: '2026-10-18',
    });
    expect(rides.map((r) => r.dateISO)).toEqual(['2026-10-18', '2026-10-18']);
  });

  it('returns nothing for an empty window', () => {
    expect(
      expandCommuteRides({
        weekdays: [2],
        from: '2026-10-14',
        until: '2026-10-14',
      }),
    ).toEqual([]);
  });
});

describe('commuteLegOf', () => {
  it('recognises only the two commute legs', () => {
    expect(commuteLegOf('commute_to_work')).toBe('commute_to_work');
    expect(commuteLegOf('commute_home')).toBe('commute_home');
    expect(commuteLegOf('easy')).toBeNull();
    expect(commuteLegOf(null)).toBeNull();
    expect(commuteLegOf(undefined)).toBeNull();
  });
});
