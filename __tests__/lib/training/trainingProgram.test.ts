import {
  expandProgram,
  PROGRAM_SESSION_COUNT,
  type PlannedSessionSpec,
} from '@/lib/training/trainingProgram';

// The program: 3 blocks × 8 weeks, Monday-aligned, anchored 2026-03-23.
// Block 1 = 8 slots/wk (4 run + 3 lift + 1 rest), Block 2 = 9 (5 run + 3 lift +
// 1 rest), Block 3 = 8 (4 run + 3 lift + 1 rest).
const ALL = expandProgram();

const dow = (iso: string): number => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0=Sun

describe('expandProgram — shape', () => {
  it('expands every block × 8 weeks into one row per session', () => {
    // 64 + 72 + 64 = 200
    expect(ALL).toHaveLength(200);
    expect(PROGRAM_SESSION_COUNT).toBe(200);
  });

  it('produces the expected run/lift/rest mix', () => {
    const by = (k: string) => ALL.filter((s) => s.sessionKind === k).length;
    expect(by('run')).toBe(104); // 32 + 40 + 32
    expect(by('lift')).toBe(72); // 24 × 3
    expect(by('rest')).toBe(24); // one per program week
  });

  it('gives every session a unique, well-formed plan_key', () => {
    const keys = ALL.map((s) => s.planKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of ALL) {
      expect(s.planKey).toBe(`${s.dateISO}:${s.sessionKind}`);
    }
  });
});

describe('expandProgram — calendar', () => {
  it('starts on the program anchor as block 1 / week 1', () => {
    const first = ALL[0]!;
    expect(first.dateISO).toBe('2026-03-23');
    expect(first).toMatchObject({ block: 1, week: 1, sessionKind: 'rest' });
  });

  it('ends on 2026-09-06 (Sunday of week 24)', () => {
    const last = ALL[ALL.length - 1]!;
    expect(last.dateISO).toBe('2026-09-06');
    expect(last).toMatchObject({ block: 3, week: 24 });
  });

  it('crosses block boundaries on the documented Mondays', () => {
    const firstOf = (block: number): PlannedSessionSpec =>
      ALL.find((s) => s.block === block)!;
    expect(firstOf(2)).toMatchObject({ dateISO: '2026-05-18', week: 9 });
    expect(firstOf(3)).toMatchObject({ dateISO: '2026-07-13', week: 17 });
  });

  it('rests only on Mondays', () => {
    const rests = ALL.filter((s) => s.sessionKind === 'rest');
    for (const r of rests) expect(dow(r.dateISO)).toBe(1); // Monday
    // ...and every Monday is a rest day (no training Mondays).
    const mondays = ALL.filter((s) => dow(s.dateISO) === 1);
    expect(mondays.every((s) => s.sessionKind === 'rest')).toBe(true);
  });
});

describe('expandProgram — targets', () => {
  it("scales a week's run distances to its volume target", () => {
    const wk1 = ALL.filter(
      (s) => s.block === 1 && s.week === 1 && s.sessionKind === 'run',
    );
    const total = wk1.reduce((n, s) => n + (s.targetDistanceKm ?? 0), 0);
    expect(total).toBeCloseTo(32, 0); // Block 1 week 1 target = 32 km
    // Tue easy (base 8) and Sat long (base 11) scaled by 32/34.
    const tue = wk1.find((s) => s.targetSessionType === 'easy')!;
    expect(tue.targetDistanceKm).toBe(7.5);
    const sat = wk1.find((s) => s.targetSessionType === 'long')!;
    expect(sat.targetDistanceKm).toBe(10.4);
  });

  it('caps easy runs and leaves quality runs uncapped', () => {
    const easy = ALL.find(
      (s) => s.block === 1 && s.targetSessionType === 'easy',
    )!;
    expect(easy.targetHrCap).toBe(154);
    const vo2 = ALL.find((s) => s.targetSessionType === 'vo2max')!;
    expect(vo2.targetHrCap).toBeNull();
    const tempo = ALL.find((s) => s.targetSessionType === 'intervals')!;
    expect(tempo.targetHrCap).toBeNull();
  });

  it('gives lifts and rest no distance or HR cap', () => {
    for (const s of ALL.filter((x) => x.sessionKind !== 'run')) {
      expect(s.targetDistanceKm).toBeNull();
      expect(s.targetHrCap).toBeNull();
    }
  });
});
