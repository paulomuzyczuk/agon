import {
  listActivitiesPage,
  getGearName,
  StravaRateLimitError,
} from '@/services/strava/client';

// The Strava HTTP client with `fetch` stubbed — asserts request shaping,
// zod parsing of responses, and rate-limit handling. No network.

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

describe('listActivitiesPage', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends pagination + time-window query params and parses the array', async () => {
    const fetchMock = mockFetch(200, [
      {
        id: 1,
        distance: 5000,
        moving_time: 1500,
        elapsed_time: 1500,
        start_date: '2026-03-25T09:00:00Z',
        start_date_local: '2026-03-25T06:00:00Z',
        sport_type: 'Run',
      },
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await listActivitiesPage('tok', {
      page: 2,
      perPage: 200,
      after: 1000,
      before: 2000,
    });

    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/athlete/activities?');
    expect(url).toContain('page=2');
    expect(url).toContain('per_page=200');
    expect(url).toContain('after=1000');
    expect(url).toContain('before=2000');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok',
    );
  });

  it('throws StravaRateLimitError on HTTP 429', async () => {
    global.fetch = mockFetch(429, {}) as unknown as typeof fetch;
    await expect(
      listActivitiesPage('tok', { page: 1, perPage: 200 }),
    ).rejects.toBeInstanceOf(StravaRateLimitError);
  });

  it('throws a generic error on other non-2xx responses', async () => {
    global.fetch = mockFetch(500, {
      message: 'boom',
    }) as unknown as typeof fetch;
    await expect(
      listActivitiesPage('tok', { page: 1, perPage: 200 }),
    ).rejects.toThrow(/failed \(500/);
  });

  it('rejects a payload that violates the schema', async () => {
    global.fetch = mockFetch(200, [
      { id: 'not-a-number', distance: 5000 },
    ]) as unknown as typeof fetch;
    await expect(
      listActivitiesPage('tok', { page: 1, perPage: 200 }),
    ).rejects.toThrow();
  });
});

describe('getGearName', () => {
  afterEach(() => jest.restoreAllMocks());

  it('parses and returns the gear name', async () => {
    global.fetch = mockFetch(200, {
      id: 'g111',
      name: 'Endorphin Speed 4',
    }) as unknown as typeof fetch;
    await expect(getGearName('tok', 'g111')).resolves.toBe('Endorphin Speed 4');
  });
});
