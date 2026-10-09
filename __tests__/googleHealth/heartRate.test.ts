import { buildHeartRateStream } from '@/services/googleHealth/heartRate';
import { listHeartRateSamplesPage } from '@/services/googleHealth/client';
import { GoogleHealthRateLimitError } from '@/services/googleHealth/client';
import type { HeartRateSample } from '@/services/googleHealth/types';

// Pure HR stream assembly + the HR client request shaping. No network/DB.

function sample(physicalTime: string, bpm: number | string): HeartRateSample {
  return {
    dataSource: { platform: 'FITBIT' },
    heartRate: { sampleTime: { physicalTime }, beatsPerMinute: Number(bpm) },
  };
}

describe('buildHeartRateStream', () => {
  it('sorts newest-first samples ascending, rebases time, and derives avg/max', () => {
    // Deliberately out of order (the API returns newest-first).
    const out = buildHeartRateStream([
      sample('2026-07-23T18:00:10Z', 130),
      sample('2026-07-23T18:00:00Z', 120),
      sample('2026-07-23T18:00:20Z', 140),
    ])!;
    expect(out.stream.timeS).toEqual([0, 10, 20]);
    expect(out.stream.heartrate).toEqual([120, 130, 140]);
    expect(out.avgHr).toBe(130);
    expect(out.maxHr).toBe(140);
  });

  it('rounds bpm and drops non-positive/invalid samples', () => {
    const out = buildHeartRateStream([
      sample('2026-07-23T18:00:00Z', 118.6),
      sample('2026-07-23T18:00:05Z', 0), // dropped
    ])!;
    expect(out.stream.heartrate).toEqual([119]);
    expect(out.avgHr).toBe(119);
  });

  it('returns null when there are no usable samples', () => {
    expect(buildHeartRateStream([])).toBeNull();
    expect(
      buildHeartRateStream([sample('2026-07-23T18:00:00Z', 0)]),
    ).toBeNull();
  });
});

function mockFetch(
  status: number,
  body: unknown,
): jest.Mock<Promise<Response>> {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

describe('listHeartRateSamplesPage', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses the fully-qualified physical_time filter with >= / <', async () => {
    const fetchMock = mockFetch(200, {
      dataPoints: [
        {
          heartRate: {
            sampleTime: { physicalTime: '2026-07-23T18:00:00Z' },
            beatsPerMinute: '120',
          },
        },
      ],
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await listHeartRateSamplesPage('tok', {
      startTime: '2026-07-23T18:00:00Z',
      endTime: '2026-07-23T19:00:00Z',
    });
    expect(out.dataPoints).toHaveLength(1);
    expect(out.dataPoints[0]!.heartRate.beatsPerMinute).toBe(120); // int64 coerced
    // URLSearchParams encodes spaces as '+'; normalize before asserting.
    const url = decodeURIComponent(
      fetchMock.mock.calls[0]![0] as string,
    ).replace(/\+/g, ' ');
    expect(url).toContain('/dataTypes/heart-rate/dataPoints?');
    expect(url).toContain(
      'heart_rate.sample_time.physical_time >= "2026-07-23T18:00:00Z"',
    );
    expect(url).toContain(
      'heart_rate.sample_time.physical_time < "2026-07-23T19:00:00Z"',
    );
  });

  it('propagates a rate-limit error', async () => {
    global.fetch = mockFetch(429, {}) as unknown as typeof fetch;
    await expect(
      listHeartRateSamplesPage('tok', {
        startTime: '2026-07-23T18:00:00Z',
        endTime: '2026-07-23T19:00:00Z',
      }),
    ).rejects.toBeInstanceOf(GoogleHealthRateLimitError);
  });
});
