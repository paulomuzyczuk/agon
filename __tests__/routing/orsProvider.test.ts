import {
  orsProvider,
  elevationGain,
  PROVIDER_NAME,
  profileOptions,
} from '@/services/routing/orsProvider';

// ORS round-trip adapter with `fetch` stubbed — asserts request shaping, zod
// parsing, and the elevation-gain derivation. No network.

const OLD_ENV = process.env;
beforeEach(() => {
  process.env = {
    ...OLD_ENV,
    ORS_API_KEY: 'test-key',
    ORS_BASE_URL: 'https://api.openrouteservice.org',
  };
});
afterEach(() => {
  process.env = OLD_ENV;
  jest.restoreAllMocks();
});

describe('elevationGain', () => {
  it('prefers the engine-provided ascent', () => {
    expect(elevationGain(123.4, [[0, 0, 0]])).toBe(123);
  });
  it('sums positive altitude deltas when ascent is absent', () => {
    // 10→20 (+10), 20→15 (−5), 15→25 (+10) ⇒ 20
    const coords = [
      [0, 0, 10],
      [0, 0, 20],
      [0, 0, 15],
      [0, 0, 25],
    ];
    expect(elevationGain(undefined, coords)).toBe(20);
  });
  it('returns null with no elevation data', () => {
    expect(
      elevationGain(undefined, [
        [0, 0],
        [0, 0],
      ]),
    ).toBeNull();
  });
});

function geojsonRoute(distance: number, ascent: number) {
  return {
    features: [
      {
        geometry: {
          coordinates: [
            [13.3, 52.4, 40],
            [13.31, 52.41, 45],
          ],
        },
        properties: {
          summary: { distance, duration: distance / 2 },
          ascent,
          descent: 5,
        },
      },
    ],
  };
}

describe('orsProvider.generateRoundTrips', () => {
  it('POSTs a round_trip request per seed and maps the response', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => geojsonRoute(24130, 267),
      text: async () => '',
    } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await orsProvider.generateRoundTrips({
      targetKm: 25,
      start: { lat: 52.4, lng: 13.3 },
      seeds: [1, 2],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/v2/directions/foot-walking/geojson');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.coordinates).toEqual([[13.3, 52.4]]); // [lng, lat]
    expect(body.options.round_trip.length).toBe(25000); // km → m
    expect(body.options.round_trip.seed).toBe(1);
    expect(body.elevation).toBe(true);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      seed: 1,
      distanceM: 24130,
      elevationGainM: 267,
      provider: PROVIDER_NAME,
    });
  });

  it('requests the cycling-regular profile when given', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => geojsonRoute(20000, 150),
      text: async () => '',
    } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    await orsProvider.generateRoundTrips({
      targetKm: 20,
      start: { lat: 52.4, lng: 13.3 },
      seeds: [1],
      profile: 'cycling-regular',
    });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/v2/directions/cycling-regular/geojson');
  });
});

describe('orsProvider.directions', () => {
  it('defaults to the foot-walking profile', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => geojsonRoute(6000, 30),
      text: async () => '',
    } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    await orsProvider.directions([
      { lat: 52.4, lng: 13.3 },
      { lat: 52.5, lng: 13.4 },
    ]);

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/v2/directions/foot-walking/geojson');
  });

  it('requests the cycling-regular profile when given', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => geojsonRoute(6000, 30),
      text: async () => '',
    } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    await orsProvider.directions(
      [
        { lat: 52.4, lng: 13.3 },
        { lat: 52.5, lng: 13.4 },
      ],
      'cycling-regular',
    );

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/v2/directions/cycling-regular/geojson');
  });
});

describe('cycling preferences (MZY-67)', () => {
  function mockFetch(): jest.Mock {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => geojsonRoute(20000, 150),
      text: async () => '',
    } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }
  const body = (fetchMock: jest.Mock) =>
    JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
  const WPS = [
    { lat: 52.4, lng: 13.3 },
    { lat: 52.5, lng: 13.4 },
  ];

  it('maps flat/hilly onto steepness_difficulty 0/3', () => {
    expect(profileOptions('cycling-road', 'flat')).toEqual({
      profile_params: { weightings: { steepness_difficulty: 0 } },
    });
    expect(profileOptions('cycling-regular', 'hilly')).toEqual({
      profile_params: { weightings: { steepness_difficulty: 3 } },
    });
  });

  it('never sends a gradient preference on foot or when unset', () => {
    expect(profileOptions('foot-walking', 'flat')).toEqual({});
    expect(profileOptions('cycling-regular', undefined)).toEqual({});
  });

  it('sends steepness alongside round_trip for a hilly loop', async () => {
    const fetchMock = mockFetch();
    await orsProvider.generateRoundTrips({
      targetKm: 20,
      start: WPS[0]!,
      seeds: [1],
      profile: 'cycling-mountain',
      hills: 'hilly',
    });
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/v2/directions/cycling-mountain/geojson');
    expect(body(fetchMock).options).toMatchObject({
      round_trip: { length: 20000, seed: 1 },
      profile_params: { weightings: { steepness_difficulty: 3 } },
    });
  });

  it('sends steepness on a point-to-point request', async () => {
    const fetchMock = mockFetch();
    await orsProvider.directions(WPS, 'cycling-road', 'flat');
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/v2/directions/cycling-road/geojson');
    expect(body(fetchMock).options).toEqual({
      profile_params: { weightings: { steepness_difficulty: 0 } },
    });
  });

  it('sends no options at all on a plain directions request', async () => {
    const fetchMock = mockFetch();
    await orsProvider.directions(WPS, 'cycling-regular');
    expect(body(fetchMock)).not.toHaveProperty('options');
  });
});
