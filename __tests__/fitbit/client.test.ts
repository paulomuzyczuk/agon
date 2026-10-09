import {
  getIntradayHeartRate,
  getDailyActivitySummary,
  getSleepLogs,
  getHrv,
  FitbitRateLimitError,
} from '@/services/fitbit/client';

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

afterEach(() => jest.restoreAllMocks());

describe('getIntradayHeartRate', () => {
  it('requests the window and returns the dataset', async () => {
    const fetchMock = mockFetch(200, {
      'activities-heart-intraday': {
        dataset: [{ time: '06:00:00', value: 120 }],
        datasetInterval: 1,
        datasetType: 'second',
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await getIntradayHeartRate(
      'tok',
      '2026-08-01',
      '06:00',
      '06:50',
    );
    expect(out).toEqual([{ time: '06:00:00', value: 120 }]);

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain(
      '/activities/heart/date/2026-08-01/1d/1sec/time/06:00/06:50.json',
    );
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['Accept-Language']).toBe('en_GB'); // force metric
  });

  it('throws FitbitRateLimitError on HTTP 429', async () => {
    global.fetch = mockFetch(429, {}) as unknown as typeof fetch;
    await expect(
      getIntradayHeartRate('tok', '2026-08-01', '06:00', '06:50'),
    ).rejects.toBeInstanceOf(FitbitRateLimitError);
  });
});

describe('getDailyActivitySummary', () => {
  it('parses the summary object', async () => {
    global.fetch = mockFetch(200, {
      summary: { steps: 8000, restingHeartRate: 60 },
    }) as unknown as typeof fetch;
    const out = await getDailyActivitySummary('tok', '2026-08-01');
    expect(out.steps).toBe(8000);
    expect(out.restingHeartRate).toBe(60);
  });

  it('rejects a payload that violates the schema', async () => {
    global.fetch = mockFetch(200, {
      summary: { steps: 'lots' },
    }) as unknown as typeof fetch;
    await expect(
      getDailyActivitySummary('tok', '2026-08-01'),
    ).rejects.toThrow();
  });
});

describe('getSleepLogs', () => {
  it('hits the 1.2 sleep range endpoint and returns the logs', async () => {
    const fetchMock = mockFetch(200, {
      sleep: [
        {
          logId: 1,
          dateOfSleep: '2026-08-02',
          startTime: '2026-08-01T23:30:00.000',
          endTime: '2026-08-02T07:00:00.000',
        },
      ],
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const out = await getSleepLogs('tok', '2026-07-01', '2026-07-31');
    expect(out).toHaveLength(1);
    expect(fetchMock.mock.calls[0]![0]).toContain(
      '/1.2/user/-/sleep/date/2026-07-01/2026-07-31.json',
    );
  });
});

describe('getHrv', () => {
  it('parses the HRV range payload', async () => {
    global.fetch = mockFetch(200, {
      hrv: [
        { dateTime: '2026-08-02', value: { dailyRmssd: 42, deepRmssd: 55 } },
      ],
    }) as unknown as typeof fetch;
    const out = await getHrv('tok', '2026-07-01', '2026-07-31');
    expect(out[0]!.value.dailyRmssd).toBe(42);
  });
});
