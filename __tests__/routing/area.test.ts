import { lookupArea, outerRings } from '@/services/routing/area';

// Nominatim area lookup (MZY-215) with fetch stubbed. No network.

const OLD_ENV = process.env;
beforeEach(() => {
  process.env = { ...OLD_ENV };
});
afterEach(() => {
  process.env = OLD_ENV;
  jest.restoreAllMocks();
});

const FOREST = [
  [13.2, 52.45],
  [13.28, 52.45],
  [13.28, 52.5],
  [13.2, 52.5],
  [13.2, 52.45],
];

function mockFetch(body: unknown, ok = true) {
  const fn = jest.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response);
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('outerRings', () => {
  it('takes the outer ring of a Polygon and of each MultiPolygon part', () => {
    expect(
      outerRings({ type: 'Polygon', coordinates: [FOREST, FOREST] }),
    ).toEqual([FOREST]);
    expect(
      outerRings({ type: 'MultiPolygon', coordinates: [[FOREST], [FOREST]] }),
    ).toHaveLength(2);
  });
  it('rejects points and malformed geometry', () => {
    expect(outerRings({ type: 'Point', coordinates: [13, 52] })).toBeNull();
    expect(outerRings({ type: 'Polygon', coordinates: [[[1, 2]]] })).toBeNull();
  });
});

describe('lookupArea', () => {
  it('returns the first real-sized polygon, bounded around the focus', async () => {
    const fn = mockFetch([
      {
        lat: '52.47',
        lon: '13.24',
        display_name:
          'Grunewald, Charlottenburg-Wilmersdorf, Berlin, Deutschland',
        geojson: { type: 'Polygon', coordinates: [FOREST] },
      },
    ]);
    const hit = await lookupArea('Grunewald', { lat: 52.49, lng: 13.32 });
    expect(hit).toMatchObject({
      lat: 52.47,
      lng: 13.24,
      label: 'Grunewald, Charlottenburg-Wilmersdorf',
      area: [FOREST],
    });
    const url = fn.mock.calls[0]![0] as string;
    expect(url).toContain('polygon_geojson=1');
    expect(url).toContain('bounded=1');
    expect(fn.mock.calls[0]![1].headers['User-Agent']).toMatch(/agon/);
  });

  it('prefers the forest over the same-named district boundary', async () => {
    const district = [
      [13.19, 52.47],
      [13.29, 52.47],
      [13.29, 52.5],
      [13.19, 52.47],
    ];
    mockFetch([
      {
        lat: '52.48',
        lon: '13.26',
        category: 'boundary',
        display_name: 'Grunewald, Charlottenburg-Wilmersdorf, Berlin',
        geojson: { type: 'Polygon', coordinates: [district] },
      },
      {
        lat: '52.47',
        lon: '13.24',
        category: 'landuse',
        display_name: 'Grunewald, Berlin, Deutschland',
        geojson: { type: 'Polygon', coordinates: [FOREST] },
      },
    ]);
    const hit = await lookupArea('Grunewald', null);
    expect(hit!.area).toEqual([FOREST]);
    expect(hit!.label).toBe('Grunewald, Berlin');
  });

  it('ignores building-sized polygons (a restaurant stays a point)', async () => {
    mockFetch([
      {
        lat: '52.46',
        lon: '13.32',
        geojson: {
          type: 'Polygon',
          coordinates: [
            [
              [13.32, 52.46],
              [13.3202, 52.46],
              [13.3202, 52.4601],
              [13.32, 52.46],
            ],
          ],
        },
      },
    ]);
    expect(await lookupArea('Glory', null)).toBeNull();
  });

  it('returns null on failure or when switched off', async () => {
    mockFetch({}, false);
    expect(await lookupArea('Grunewald', null)).toBeNull();
    global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
    expect(await lookupArea('Grunewald', null)).toBeNull();
    process.env.ROUTING_AREA_LOOKUP = '0';
    const fn = mockFetch([]);
    expect(await lookupArea('Grunewald', null)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});
