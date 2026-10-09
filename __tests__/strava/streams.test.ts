import {
  fetchStravaRunStreams,
  withStravaWattsSource,
} from '@/services/strava/streams';
import { StravaRateLimitError } from '@/services/strava/client';

// Strava streams fetch with `fetch` stubbed — request shaping, parsing of the
// key_by_type object into aligned arrays, and the null/error paths. No network.

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

describe('fetchStravaRunStreams', () => {
  it('parses the key_by_type streams into aligned arrays', async () => {
    const fetchMock = mockFetch(200, {
      time: { data: [0, 1, 2] },
      heartrate: { data: [120, 130.6, 140] },
      distance: { data: [0, 3.1, 6.4] },
      velocity_smooth: { data: [0, 3.1, 3.3] },
      moving: { data: [false, true, true] },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await fetchStravaRunStreams('tok', 555);
    expect(out).not.toBeNull();
    expect(out!.timeS).toEqual([0, 1, 2]);
    expect(out!.heartrate).toEqual([120, 131, 140]); // rounded
    expect(out!.distanceM).toEqual([0, 3.1, 6.4]);
    expect(out!.moving).toEqual([false, true, true]);
    expect(out!.cadence).toBeNull(); // key absent -> null
    expect(out!.lat).toBeNull(); // latlng key absent -> null track
    expect(out!.lng).toBeNull();

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/activities/555/streams');
    expect(url).toContain('key_by_type=true');
    expect(url).toContain('keys=time,heartrate');
    expect(url).toContain('latlng'); // GPS track requested
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok',
    );
  });

  it('splits the latlng pairs into aligned lat/lng arrays', async () => {
    global.fetch = mockFetch(200, {
      time: { data: [0, 1, 2] },
      latlng: { data: [[52.5, 13.4], null, [52.51, 13.41]] },
    }) as unknown as typeof fetch;

    const out = await fetchStravaRunStreams('tok', 9);
    expect(out!.lat).toEqual([52.5, null, 52.51]);
    expect(out!.lng).toEqual([13.4, null, 13.41]);
  });

  it('returns null when the activity has no streams (404)', async () => {
    global.fetch = mockFetch(404, {}) as unknown as typeof fetch;
    await expect(fetchStravaRunStreams('tok', 1)).resolves.toBeNull();
  });

  it('returns null when there is no time axis to align on', async () => {
    global.fetch = mockFetch(200, {
      heartrate: { data: [120, 121] },
    }) as unknown as typeof fetch;
    await expect(fetchStravaRunStreams('tok', 1)).resolves.toBeNull();
  });

  it('throws StravaRateLimitError on HTTP 429', async () => {
    global.fetch = mockFetch(429, {}) as unknown as typeof fetch;
    await expect(fetchStravaRunStreams('tok', 1)).rejects.toBeInstanceOf(
      StravaRateLimitError,
    );
  });
});

describe('watts stream (MZY-267)', () => {
  it('requests and parses the watts stream, unlabelled', async () => {
    const fetchMock = mockFetch(200, {
      time: { data: [0, 1, 2] },
      watts: { data: [150.4, null, 210] },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await fetchStravaRunStreams('tok', 7);
    expect(fetchMock.mock.calls[0]![0]).toContain(',watts&');
    expect(out!.watts).toEqual([150, null, 210]);
    expect(out!.wattsSource).toBeNull();
  });

  it('leaves watts null when Strava returns no power stream', async () => {
    global.fetch = mockFetch(200, {
      time: { data: [0, 1] },
    }) as unknown as typeof fetch;
    const out = await fetchStravaRunStreams('tok', 7);
    expect(out!.watts).toBeNull();
  });
});

describe('withStravaWattsSource', () => {
  const base = { timeS: [0, 1], watts: [100, 110] };

  it("labels meter watts 'device' and everything else 'estimated'", () => {
    expect(withStravaWattsSource(base, true).wattsSource).toBe('device');
    expect(withStravaWattsSource(base, false).wattsSource).toBe('estimated');
    expect(withStravaWattsSource(base, undefined).wattsSource).toBe(
      'estimated',
    );
  });

  it('leaves a stream without watts unlabelled', () => {
    const out = withStravaWattsSource({ timeS: [0, 1], watts: null }, true);
    expect(out.watts).toBeNull();
    expect(out.wattsSource).toBeNull();
  });
});
