import {
  compassDirection,
  routeBearing,
  selectDiverse,
} from '@/services/routing/diversity';
import type { RankedCandidate } from '@/services/routing/rank';

describe('compassDirection', () => {
  it('maps bearings to the 8-point compass', () => {
    expect(compassDirection(0)).toBe('N');
    expect(compassDirection(45)).toBe('NE');
    expect(compassDirection(90)).toBe('E');
    expect(compassDirection(180)).toBe('S');
    expect(compassDirection(270)).toBe('W');
    expect(compassDirection(359)).toBe('N'); // wraps
  });
});

describe('routeBearing', () => {
  const start = { lat: 52.49, lng: 13.32 };
  it('points to the apex (farthest point) — north', () => {
    // apex due north of start
    const b = routeBearing(start, [
      [13.32, 52.49],
      [13.32, 52.55], // north
      [13.32, 52.49],
    ]);
    expect(compassDirection(b)).toBe('N');
  });
  it('points east when the apex is east', () => {
    const b = routeBearing(start, [
      [13.32, 52.49],
      [13.42, 52.49], // east
      [13.32, 52.49],
    ]);
    expect(compassDirection(b)).toBe('E');
  });
});

function cand(
  seed: number,
  apex: [number, number],
  errM: number,
): RankedCandidate {
  return {
    seed,
    distanceM: 10000,
    elevationGainM: 50,
    elevationGainPerKmM: 5,
    coordinates: [[13.32, 52.49], apex, [13.32, 52.49]],
    provider: 'test',
    distanceErrorM: errM,
  };
}

describe('selectDiverse', () => {
  const start = { lat: 52.49, lng: 13.32 };

  it('picks directionally-spread routes, not the 3 most similar', () => {
    // Four candidates: three head NORTH (near-identical direction), one EAST.
    const ranked: RankedCandidate[] = [
      cand(1, [13.32, 52.55], 50), // N (best accuracy)
      cand(2, [13.325, 52.55], 60), // ~N
      cand(3, [13.318, 52.55], 70), // ~N
      cand(4, [13.42, 52.49], 400), // E (worse accuracy but different direction)
    ];
    const picked = selectDiverse(ranked, start, 2);
    const dirs = picked.map((p) => p.direction);
    // The most accurate (N) plus the East one — diversity beats picking two Norths.
    expect(dirs).toContain('N');
    expect(dirs).toContain('E');
  });

  it('annotates every returned candidate with bearing + direction', () => {
    const picked = selectDiverse([cand(1, [13.32, 52.55], 50)], start, 3);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.direction).toBe('N');
    expect(typeof picked[0]!.bearingDeg).toBe('number');
  });
});
