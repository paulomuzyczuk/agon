import { isWristStepsSource, buildStepsBuckets, fetchWristStepsBuckets } from '@/services/googleHealth/steps';
import { GoogleHealthRateLimitError } from '@/services/googleHealth/client';
import type { WellnessDataPoint } from '@/services/googleHealth/types';

function stepsPoint(
  platform: string,
  deviceName: string | undefined,
  startTime: string,
  endTime: string,
  count: number | string,
): WellnessDataPoint {
  return {
    dataSource: { platform, device: deviceName !== undefined ? { displayName: deviceName } : undefined },
    steps: { interval: { startTime, endTime }, count },
  } as unknown as WellnessDataPoint;
}

describe('isWristStepsSource', () => {
  it('accepts the Fitbit wrist device', () => {
    expect(isWristStepsSource(stepsPoint('FITBIT', 'Google Fitbit Air', '', '', 0))).toBe(true);
  });

  it('rejects MobileTrack (the phone-fallback tracker on the same platform)', () => {
    expect(isWristStepsSource(stepsPoint('FITBIT', 'MobileTrack', '', '', 0))).toBe(false);
  });

  it('rejects non-Fitbit platforms (e.g. HEALTH_CONNECT)', () => {
    expect(isWristStepsSource(stepsPoint('HEALTH_CONNECT', undefined, '', '', 0))).toBe(false);
  });
});

describe('buildStepsBuckets', () => {
  it('keeps only wrist-device points, sorted by start time', () => {
    const out = buildStepsBuckets([
      stepsPoint('FITBIT', 'Google Fitbit Air', '2026-09-05T10:01:00Z', '2026-09-05T10:02:00Z', 103),
      stepsPoint('FITBIT', 'MobileTrack', '2026-09-05T10:00:00Z', '2026-09-05T10:01:00Z', 101), // dropped
      stepsPoint('HEALTH_CONNECT', undefined, '2026-09-05T10:00:30Z', '2026-09-05T10:01:30Z', 90), // dropped
      stepsPoint('FITBIT', 'Google Fitbit Air', '2026-09-05T10:00:00Z', '2026-09-05T10:01:00Z', 101),
    ]);
    expect(out).toEqual([
      { startMs: Date.parse('2026-09-05T10:00:00Z'), endMs: Date.parse('2026-09-05T10:01:00Z'), steps: 101 },
      { startMs: Date.parse('2026-09-05T10:01:00Z'), endMs: Date.parse('2026-09-05T10:02:00Z'), steps: 103 },
    ]);
  });

  it('coerces a string step count (Google encodes int64 as a string)', () => {
    const out = buildStepsBuckets([
      stepsPoint('FITBIT', 'Google Fitbit Air', '2026-09-05T10:00:00Z', '2026-09-05T10:01:00Z', '124'),
    ]);
    expect(out).toEqual([{ startMs: expect.any(Number), endMs: expect.any(Number), steps: 124 }]);
  });

  it('drops points with no usable interval or a non-finite/negative count', () => {
    const out = buildStepsBuckets([
      stepsPoint('FITBIT', 'Google Fitbit Air', '', '2026-09-05T10:01:00Z', 100), // no start
      stepsPoint('FITBIT', 'Google Fitbit Air', '2026-09-05T10:02:00Z', '2026-09-05T10:01:00Z', 100), // end <= start
      stepsPoint('FITBIT', 'Google Fitbit Air', '2026-09-05T10:00:00Z', '2026-09-05T10:01:00Z', -5), // negative
      stepsPoint('FITBIT', 'Google Fitbit Air', '2026-09-05T10:00:00Z', '2026-09-05T10:01:00Z', 'not-a-number'),
    ]);
    expect(out).toEqual([]);
  });

  it('dedupes exact duplicate start times, keeping the first', () => {
    const out = buildStepsBuckets([
      stepsPoint('FITBIT', 'Google Fitbit Air', '2026-09-05T10:00:00Z', '2026-09-05T10:01:00Z', 100),
      stepsPoint('FITBIT', 'Google Fitbit Air', '2026-09-05T10:00:00Z', '2026-09-05T10:01:00Z', 999),
    ]);
    expect(out).toEqual([{ startMs: expect.any(Number), endMs: expect.any(Number), steps: 100 }]);
  });
});

function mockFetch(status: number, body: unknown): jest.Mock<Promise<Response>> {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

describe('fetchWristStepsBuckets', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses the fully-qualified steps.interval.start_time filter and filters to the wrist device', async () => {
    const fetchMock = mockFetch(200, {
      dataPoints: [
        {
          dataSource: { platform: 'FITBIT', device: { displayName: 'MobileTrack' } },
          steps: { interval: { startTime: '2026-09-05T10:00:00Z', endTime: '2026-09-05T10:01:00Z' }, count: '999' },
        },
        {
          dataSource: { platform: 'FITBIT', device: { displayName: 'Google Fitbit Air' } },
          steps: { interval: { startTime: '2026-09-05T10:00:00Z', endTime: '2026-09-05T10:01:00Z' }, count: '101' },
        },
      ],
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await fetchWristStepsBuckets(
      'tok',
      Date.parse('2026-09-05T10:00:00Z'),
      Date.parse('2026-09-05T10:01:00Z'),
    );
    expect(out).toEqual([{ startMs: expect.any(Number), endMs: expect.any(Number), steps: 101 }]);

    const url = decodeURIComponent(fetchMock.mock.calls[0]![0] as string).replace(/\+/g, ' ');
    expect(url).toContain('/dataTypes/steps/dataPoints?');
    expect(url).toContain('steps.interval.start_time >= "2026-09-05T10:00:00.000Z"');
    expect(url).toContain('steps.interval.start_time < "2026-09-05T10:01:00.000Z"');
  });

  it('propagates a rate-limit error', async () => {
    global.fetch = mockFetch(429, {}) as unknown as typeof fetch;
    await expect(fetchWristStepsBuckets('tok', 0, 60_000)).rejects.toBeInstanceOf(GoogleHealthRateLimitError);
  });
});
