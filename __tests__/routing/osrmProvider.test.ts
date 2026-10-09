import { osrmProvider } from '@/services/routing/osrmProvider';

// FOSSGIS OSRM fallback adapter (MZY-215) with fetch stubbed. No network.

afterEach(() => jest.restoreAllMocks());

function mockFetch(body: unknown, ok = true) {
  const fn = jest.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 503,
    json: async () => body,
    text: async () => 'down',
  } as Response);
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const WPS = [
  { lat: 52.5, lng: 13.4 },
  { lat: 52.46, lng: 13.32 },
];

describe('osrmProvider.directions', () => {
  it('routes via the per-mode FOSSGIS server and parses the route', async () => {
    const fn = mockFetch({
      code: 'Ok',
      routes: [
        {
          distance: 8123.4,
          geometry: {
            coordinates: [
              [13.4, 52.5],
              [13.32, 52.46],
            ],
          },
        },
      ],
    });
    const r = await osrmProvider.directions(WPS, 'cycling-regular');
    const url = fn.mock.calls[0]![0] as string;
    expect(url).toContain(
      '/routed-bike/route/v1/driving/13.4,52.5;13.32,52.46',
    );
    expect(url).toContain('geometries=geojson');
    expect(r).toMatchObject({
      distanceM: 8123.4,
      elevationGainM: null,
      provider: 'osrm',
    });
  }, 10000);

  it('uses the foot server by default and surfaces errors', async () => {
    const fn = mockFetch({ code: 'NoRoute', message: 'Impossible route' });
    await expect(osrmProvider.directions(WPS)).rejects.toThrow(/NoRoute/);
    expect(fn.mock.calls[0]![0] as string).toContain('/routed-foot/');
  }, 10000);

  it('does not do round trips', async () => {
    await expect(
      osrmProvider.generateRoundTrips({ targetKm: 5, start: WPS[0]! }),
    ).rejects.toThrow(/not supported/);
  });
});
