import { resampleCadence, bucketCoverageFraction, type StepsBucket } from '@/lib/fitbitCadence';

describe('resampleCadence', () => {
  it('broadcasts each bucket rate across every target sample inside it', () => {
    const runStartMs = Date.parse('2026-09-05T10:00:00Z');
    const buckets: StepsBucket[] = [
      { startMs: runStartMs, endMs: runStartMs + 60_000, steps: 150 }, // 150 spm
      { startMs: runStartMs + 60_000, endMs: runStartMs + 120_000, steps: 0 }, // 0 spm
    ];
    // Samples at 0s, 30s, 65s, 100s (relative to run start).
    const timeS = [0, 30, 65, 100];
    const { cadence, coveredSamples } = resampleCadence(buckets, timeS, runStartMs);
    expect(cadence).toEqual([150, 150, 0, 0]);
    expect(coveredSamples).toBe(4);
  });

  it('returns null for samples with no covering bucket (a real gap, not zero)', () => {
    const runStartMs = Date.parse('2026-09-05T10:00:00Z');
    const buckets: StepsBucket[] = [
      { startMs: runStartMs, endMs: runStartMs + 60_000, steps: 120 },
      // Gap: no bucket for 60-180s.
      { startMs: runStartMs + 180_000, endMs: runStartMs + 240_000, steps: 160 },
    ];
    const timeS = [0, 90, 200];
    const { cadence, coveredSamples } = resampleCadence(buckets, timeS, runStartMs);
    expect(cadence).toEqual([120, null, 160]);
    expect(coveredSamples).toBe(2);
  });

  it('returns an all-null result for empty buckets', () => {
    const { cadence, coveredSamples } = resampleCadence([], [0, 10, 20], Date.now());
    expect(cadence).toEqual([null, null, null]);
    expect(coveredSamples).toBe(0);
  });

  it('rounds the steps/min rate for a non-60s bucket', () => {
    const runStartMs = Date.parse('2026-09-05T10:00:00Z');
    const buckets: StepsBucket[] = [
      // 30s bucket, 62 steps -> 124 spm
      { startMs: runStartMs, endMs: runStartMs + 30_000, steps: 62 },
    ];
    const { cadence } = resampleCadence(buckets, [10], runStartMs);
    expect(cadence).toEqual([124]);
  });
});

describe('bucketCoverageFraction', () => {
  it('is 1.0 when every expected minute has a bucket', () => {
    const buckets: StepsBucket[] = Array.from({ length: 10 }, (_, i) => ({
      startMs: i * 60_000,
      endMs: (i + 1) * 60_000,
      steps: 100,
    }));
    expect(bucketCoverageFraction(buckets, 600)).toBe(1);
  });

  it('reflects a partial-coverage run', () => {
    const buckets: StepsBucket[] = [{ startMs: 0, endMs: 60_000, steps: 100 }];
    // 600s run, 10 expected buckets, only 1 present.
    expect(bucketCoverageFraction(buckets, 600)).toBeCloseTo(0.1);
  });

  it('is 0 for a zero-or-negative duration', () => {
    expect(bucketCoverageFraction([{ startMs: 0, endMs: 60_000, steps: 1 }], 0)).toBe(0);
  });

  it('caps at 1.0 even with more buckets than expected minutes', () => {
    const buckets: StepsBucket[] = Array.from({ length: 5 }, (_, i) => ({
      startMs: i * 60_000,
      endMs: (i + 1) * 60_000,
      steps: 100,
    }));
    expect(bucketCoverageFraction(buckets, 60)).toBe(1);
  });
});
