import {
  createSplitTracker,
  formatDuration,
  summarizeLive,
} from '@/lib/liveSplits';

const START = 1_800_000_000_000;
const at = (s: number) => START + s * 1000;

/** A steady runner: `paceS` seconds per km, one fix per second. */
function run(paceS: number, seconds: number) {
  const t = createSplitTracker(START);
  for (let s = 1; s <= seconds; s++) t.add(at(s), (s / paceS) * 1000);
  return t;
}

describe('createSplitTracker', () => {
  it('places each km crossing by interpolation, not at the fix', () => {
    const t = createSplitTracker(START);
    t.add(at(100), 400);
    t.add(at(200), 1200); // crosses 1000 m 75% of the way through this step
    expect(t.crossingsS()).toEqual([175]);
  });

  it('records every km crossed in one long step', () => {
    const t = createSplitTracker(START);
    t.add(at(0), 0);
    t.add(at(600), 2500); // tunnel: GPS gap spanning two km marks
    expect(t.crossingsS()).toEqual([240, 480]);
  });

  it('is exact on the boundary and ignores a fix that did not advance', () => {
    const t = createSplitTracker(START);
    t.add(at(300), 1000);
    t.add(at(310), 1000);
    expect(t.crossingsS()).toEqual([300]);
  });

  it('steady 5:00/km gives 300 s splits', () => {
    expect(run(300, 905).crossingsS()).toEqual([300, 600, 900]);
  });
});

describe('summarizeLive', () => {
  it('reports pace inside the current km separately from the average', () => {
    // 5:00/km for 2 km, then a slower 6:00/km for 500 m.
    const t = run(300, 600);
    for (let s = 1; s <= 180; s++) t.add(at(600 + s), 2000 + (s / 360) * 1000);
    const s = summarizeLive({
      startedAtMs: START,
      nowMs: at(780),
      distanceM: 2500,
      fixTMs: at(780),
      crossingsS: t.crossingsS(),
    });
    expect(s.splitsS).toEqual([300, 300]);
    expect(s.currentKmProgressM).toBe(500);
    expect(s.currentKmPaceSecPerKm).toBeCloseTo(360, 5);
    expect(s.avgPaceSecPerKm).toBeCloseTo(312, 5);
    expect(s.elapsedS).toBe(780);
  });

  it('shows no pace in the first metres of the activity or of a km', () => {
    const early = summarizeLive({
      startedAtMs: START,
      nowMs: at(5),
      distanceM: 12,
      fixTMs: at(5),
      crossingsS: [],
    });
    expect(early.avgPaceSecPerKm).toBeNull();
    expect(early.currentKmPaceSecPerKm).toBeNull();

    const justPastKm = summarizeLive({
      startedAtMs: START,
      nowMs: at(302),
      distanceM: 1010,
      fixTMs: at(302),
      crossingsS: [300],
    });
    expect(justPastKm.currentKmPaceSecPerKm).toBeNull();
    expect(justPastKm.avgPaceSecPerKm).not.toBeNull();
  });

  it('keeps counting elapsed time between fixes', () => {
    const s = summarizeLive({
      startedAtMs: START,
      nowMs: at(130),
      distanceM: 400,
      fixTMs: at(120),
      crossingsS: [],
    });
    expect(s.elapsedS).toBe(130);
    expect(s.avgPaceSecPerKm).toBeCloseTo(300, 5); // paced at the fix, not now
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [9, '0:09'],
    [305, '5:05'],
    [3599, '59:59'],
    [3909, '1:05:09'],
    [-4, '0:00'],
  ])('%s s → %s', (s, text) => {
    expect(formatDuration(s)).toBe(text);
  });
});
