import { computeBlockWeek, programWeekRange } from '@/lib/training/trainingBlocks';

// Program anchor: 2026-03-23 is week 1 / block 1 (Monday, ISO CW13).
describe('computeBlockWeek', () => {
  it('stamps the start date as week 1, block 1', () => {
    expect(computeBlockWeek('2026-03-23')).toEqual({ block: 1, week: 1 });
  });

  it('keeps the whole first 7 days in week 1', () => {
    expect(computeBlockWeek('2026-03-29')).toEqual({ block: 1, week: 1 });
  });

  it('rolls to week 2 on day 8', () => {
    expect(computeBlockWeek('2026-03-30')).toEqual({ block: 1, week: 2 });
  });

  it('keeps week 8 in block 1', () => {
    // day 55 = 2026-05-17 → week 8
    expect(computeBlockWeek('2026-05-17')).toEqual({ block: 1, week: 8 });
  });

  it('starts block 2 at week 9', () => {
    // day 56 = 2026-05-18 → week 9
    expect(computeBlockWeek('2026-05-18')).toEqual({ block: 2, week: 9 });
  });

  it('starts block 3 at week 17', () => {
    // day 112 = 2026-07-13 → week 17
    expect(computeBlockWeek('2026-07-13')).toEqual({ block: 3, week: 17 });
  });

  it('returns nulls for pre-program dates', () => {
    expect(computeBlockWeek('2026-03-22')).toEqual({ block: null, week: null });
  });

  it('clamps the reported block to 3 for an over-run program but keeps counting weeks', () => {
    const far = computeBlockWeek('2027-01-01');
    expect(far.block).toBe(3);
    expect(far.week).toBeGreaterThan(24);
  });

  it('rejects malformed dates', () => {
    expect(() => computeBlockWeek('not-a-date')).toThrow();
  });
});

describe('programWeekRange', () => {
  it('returns the Monday–Sunday range of week 1', () => {
    expect(programWeekRange('2026-03-25')).toEqual({
      start: '2026-03-23',
      end: '2026-03-29',
    });
  });

  it('advances a week on day 8', () => {
    expect(programWeekRange('2026-03-30')).toEqual({
      start: '2026-03-30',
      end: '2026-04-05',
    });
  });

  it('is null before the program starts', () => {
    expect(programWeekRange('2026-03-22')).toBeNull();
  });
});
