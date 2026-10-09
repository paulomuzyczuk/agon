import {
  fetchActivityBestEfforts,
  pickPrPerDistance,
  type StravaBestEffort,
} from '@/services/strava/bestEfforts';
import { StravaRateLimitError } from '@/services/strava/client';

// bestEfforts with `fetch` stubbed — request shaping + parsing of the detailed
// activity's best_efforts array, and the pure PR-per-distance rollup. No network,
// no DB (the fetch + pure paths never touch the pool).

function mockFetch(status: number, body: unknown): jest.Mock<Promise<Response>> {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

afterEach(() => jest.restoreAllMocks());

describe('fetchActivityBestEfforts', () => {
  it('requests the detailed activity with include_all_efforts and parses efforts', async () => {
    const fetchMock = mockFetch(200, {
      id: 42,
      start_date: '2026-05-18T06:00:00Z',
      best_efforts: [
        {
          name: '5k',
          distance: 5000,
          elapsed_time: 1500,
          moving_time: 1495,
          pr_rank: 1,
          start_date: '2026-05-18T06:05:00Z',
        },
        { name: '10k', distance: 10000, elapsed_time: 3120, pr_rank: null },
      ],
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await fetchActivityBestEfforts('tok', 42);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      activityId: 42,
      name: '5k',
      distanceM: 5000,
      elapsedTimeS: 1500,
      movingTimeS: 1495,
      prRank: 1,
      startedAt: '2026-05-18T06:05:00.000Z',
      activityStartedAt: '2026-05-18T06:00:00.000Z',
    });
    expect(out[1]!.movingTimeS).toBeNull(); // moving_time absent -> null
    expect(out[1]!.prRank).toBeNull();

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/activities/42');
    expect(url).toContain('include_all_efforts=true');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok',
    );
  });

  it('drops zero-distance / zero-time efforts', async () => {
    global.fetch = mockFetch(200, {
      id: 1,
      best_efforts: [
        { name: '400m', distance: 0, elapsed_time: 60 },
        { name: '1k', distance: 1000, elapsed_time: 0 },
        { name: '5k', distance: 5000, elapsed_time: 1500 },
      ],
    }) as unknown as typeof fetch;
    const out = await fetchActivityBestEfforts('tok', 1);
    expect(out.map((e) => e.name)).toEqual(['5k']);
  });

  it('returns [] when the activity has no best_efforts (e.g. not a run)', async () => {
    global.fetch = mockFetch(200, { id: 7 }) as unknown as typeof fetch;
    await expect(fetchActivityBestEfforts('tok', 7)).resolves.toEqual([]);
  });

  it('returns [] on 404', async () => {
    global.fetch = mockFetch(404, {}) as unknown as typeof fetch;
    await expect(fetchActivityBestEfforts('tok', 7)).resolves.toEqual([]);
  });

  it('throws StravaRateLimitError on HTTP 429', async () => {
    global.fetch = mockFetch(429, {}) as unknown as typeof fetch;
    await expect(fetchActivityBestEfforts('tok', 7)).rejects.toBeInstanceOf(
      StravaRateLimitError,
    );
  });
});

describe('pickPrPerDistance', () => {
  const effort = (
    name: string,
    distanceM: number,
    elapsedTimeS: number,
    activityId = 1,
  ): StravaBestEffort => ({
    activityId,
    name,
    distanceM,
    elapsedTimeS,
    movingTimeS: null,
    prRank: null,
    startedAt: null,
    activityStartedAt: null,
  });

  it('keeps the fastest split per named distance', () => {
    const prs = pickPrPerDistance([
      effort('5k', 5000, 1520, 1),
      effort('5k', 5000, 1500, 2), // faster — wins
      effort('10k', 10000, 3200, 3),
      effort('5k', 5000, 1510, 4),
    ]);
    const byName = Object.fromEntries(prs.map((p) => [p.name, p]));
    expect(byName['5k']!.elapsedTimeS).toBe(1500);
    expect(byName['5k']!.activityId).toBe(2);
    expect(byName['10k']!.elapsedTimeS).toBe(3200);
  });

  it('sorts the PR table by distance ascending', () => {
    const prs = pickPrPerDistance([
      effort('10k', 10000, 3200),
      effort('1k', 1000, 240),
      effort('Half-Marathon', 21097, 7200),
      effort('5k', 5000, 1500),
    ]);
    expect(prs.map((p) => p.name)).toEqual(['1k', '5k', '10k', 'Half-Marathon']);
  });

  it('returns [] for no efforts', () => {
    expect(pickPrPerDistance([])).toEqual([]);
  });
});
