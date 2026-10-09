import {
  geocode,
  matchWarning,
  pickBestFeature,
} from '@/services/routing/geocode';

const OLD_ENV = process.env;
beforeEach(() => {
  process.env = {
    ...OLD_ENV,
    ORS_API_KEY: 'test-key',
    AGON_HOME_LAT: '52.516275',
    AGON_HOME_LNG: '13.377704',
  };
});
afterEach(() => {
  process.env = OLD_ENV;
  jest.restoreAllMocks();
});

function mockJson(body: unknown) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => '',
  } as Response);
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('geocode', () => {
  it('returns the top feature with lat/lng flipped from GeoJSON order + label', async () => {
    const fetchMock = mockJson({
      features: [
        {
          geometry: { coordinates: [13.377704, 52.516275] }, // [lon, lat]
          properties: { label: 'Pariser Platz 1, Berlin, Germany' },
        },
      ],
    });
    const hit = await geocode('Pariser Platz 1, 10117 Berlin');
    expect(hit).toEqual({
      lat: 52.516275,
      lng: 13.377704,
      label: 'Pariser Platz 1, Berlin, Germany',
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/geocode/search?');
    // Biased toward home, but NOT restricted to a country.
    expect(url).toContain('focus.point.lat=52.516275');
    expect(url).not.toContain('boundary.country');
  });

  it('returns null when the geocoder finds nothing', async () => {
    mockJson({ features: [] });
    expect(await geocode('nowhere at all')).toBeNull();
  });

  it('bounds the first search to a circle around the reference point', async () => {
    // Short local names like "Tiergarten" exist in several countries; the
    // bounded first pass is what keeps them resolving locally.
    const fetchMock = mockJson({
      features: [
        {
          geometry: { coordinates: [13.35, 52.514] },
          properties: { label: 'Tiergarten, Berlin, Germany' },
        },
      ],
    });
    await geocode('Tiergarten');
    expect(fetchMock).toHaveBeenCalledTimes(1); // a local hit needs no retry
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('boundary.circle.lat=52.516275');
    expect(url).toContain('boundary.circle.radius=75');
  });

  it('retries worldwide when nothing is found nearby (travelling)', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ features: [] }), // nothing within 75 km of home
        text: async () => '',
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          features: [
            {
              geometry: { coordinates: [33.0413, 34.6786] },
              properties: { label: 'Limassol, Cyprus' },
            },
          ],
        }),
        text: async () => '',
      } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const hit = await geocode('Limassol, Cyprus');
    expect(hit).toEqual({ lat: 34.6786, lng: 33.0413, label: 'Limassol, Cyprus' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The second pass drops the circle so a distant place can resolve.
    expect(fetchMock.mock.calls[1]![0] as string).not.toContain(
      'boundary.circle',
    );
  });

  it('never restricts by country, near or far', async () => {
    const fetchMock = mockJson({ features: [] });
    await geocode('anywhere');
    for (const call of fetchMock.mock.calls) {
      expect(call[0] as string).not.toContain('boundary.country');
    }
  });

  it('honours a custom search radius', async () => {
    process.env.ROUTING_GEOCODE_RADIUS_KM = '120';
    const fetchMock = mockJson({ features: [] });
    await geocode('somewhere');
    expect(fetchMock.mock.calls[0]![0] as string).toContain(
      'boundary.circle.radius=120',
    );
  });

  it('biases toward an explicit focus point when one is given', async () => {
    const fetchMock = mockJson({
      features: [
        {
          geometry: { coordinates: [33.62, 34.9] },
          properties: { label: 'Larnaca, Cyprus' },
        },
      ],
    });
    await geocode('Larnaca', { lat: 34.9, lng: 33.63 });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('focus.point.lat=34.9');
    expect(url).toContain('focus.point.lon=33.63');
  });

  it('omits the focus point entirely when bias is explicitly null', async () => {
    const fetchMock = mockJson({ features: [] });
    await geocode('somewhere', null);
    expect(fetchMock.mock.calls[0]![0] as string).not.toContain('focus.point');
  });

  it('falls back to no bias when home coordinates are not configured', async () => {
    delete process.env.AGON_HOME_LAT;
    delete process.env.AGON_HOME_LNG;
    const fetchMock = mockJson({ features: [] });
    await expect(geocode('anywhere')).resolves.toBeNull();
    expect(fetchMock.mock.calls[0]![0] as string).not.toContain('focus.point');
  });
});

describe('pickBestFeature — same street in two Bezirke (MZY-215)', () => {
  const charlottenburg = {
    geometry: { coordinates: [13.2958, 52.5185] as [number, number] },
    properties: {
      label: 'Schloßstraße 1, Berlin, Germany',
      name: 'Schloßstraße 1',
      neighbourhood: 'Charlottenburg',
      borough: 'Charlottenburg-Wilmersdorf',
      postalcode: '14059',
    },
  };
  const steglitz = {
    geometry: { coordinates: [13.3209, 52.4566] as [number, number] },
    properties: {
      label: 'Schloßstraße 1, Berlin, Germany',
      name: 'Schloßstraße 1',
      neighbourhood: 'Steglitz',
      borough: 'Steglitz-Zehlendorf',
      postalcode: '12165',
    },
  };

  it('prefers the hit whose Bezirk the query names', () => {
    expect(
      pickBestFeature('Schloßstraße 1, Steglitz', [charlottenburg, steglitz]),
    ).toBe(steglitz);
    expect(
      pickBestFeature('Schlossstrasse 1 Charlottenburg', [
        steglitz,
        charlottenburg,
      ]),
    ).toBe(charlottenburg);
  });

  it('matches on the postcode too', () => {
    expect(
      pickBestFeature('Schloßstraße 1, 12165 Berlin', [
        charlottenburg,
        steglitz,
      ]),
    ).toBe(steglitz);
  });

  it("keeps Pelias's order when the query says nothing distinguishing", () => {
    expect(pickBestFeature('Schloßstraße 1', [charlottenburg, steglitz])).toBe(
      charlottenburg,
    );
    expect(pickBestFeature('anything', [])).toBeUndefined();
  });

  it('geocode() applies it across the fetched hits', async () => {
    const fetchMock = mockJson({ features: [charlottenburg, steglitz] });
    const hit = await geocode('Schloßstraße 1, Steglitz');
    expect(hit).toMatchObject({ lat: 52.4566, lng: 13.3209 });
    expect(fetchMock.mock.calls[0]![0] as string).toContain('size=5');
  });
});

describe('pickBestFeature — venue name vs. a plausible Bezirk (MZY-219)', () => {
  // Pelias's real hits for this query, trimmed. The right venue is filed under
  // Kreuzberg with "Am Flutgraben" only as its street; the wrong one sits in
  // Treptow-Köpenick, so the query's "Alt-Treptow" matched ITS borough.
  const visionaere = {
    geometry: { coordinates: [13.45048, 52.496796] as [number, number] },
    properties: {
      label: 'Club der Visionaere, Berlin, Germany',
      name: 'Club der Visionaere',
      street: 'Am Flutgraben',
      neighbourhood: 'Kreuzberg',
      borough: 'Friedrichshain-Kreuzberg',
      locality: 'Berlin',
      postalcode: '12435',
    },
  };
  const wellness = {
    geometry: { coordinates: [13.512727, 52.461601] as [number, number] },
    properties: {
      label: 'Der Wellness Club, Berlin, Germany',
      name: 'Der Wellness Club',
      street: 'Wilhelminenhofstraße',
      neighbourhood: 'Oberschöneweide',
      borough: 'Treptow-Kopenick',
      locality: 'Berlin',
      postalcode: '12459',
    },
  };
  const query = 'Club der Visionaere, Am Flutgraben, Alt-Treptow';

  it('prefers the hit whose own name matches over one in a matching Bezirk', () => {
    expect(pickBestFeature(query, [visionaere, wellness])).toBe(visionaere);
    // Not just Pelias's order winning a tie.
    expect(pickBestFeature(query, [wellness, visionaere])).toBe(visionaere);
  });

  it('matches the name across umlaut spellings', () => {
    expect(
      pickBestFeature('Club der Visionäre, Alt-Treptow', [
        wellness,
        visionaere,
      ]),
    ).toBe(visionaere);
  });

  it('does not count shared articles as a name match', () => {
    // "der" + "club" alone would tie; the distinctive "visionaere" decides.
    expect(pickBestFeature('Der Club Visionaere', [wellness, visionaere])).toBe(
      visionaere,
    );
  });

  it('still prefers name + area over a hit that only matches by name', () => {
    const park = {
      geometry: { coordinates: [13.4025, 52.5433] as [number, number] },
      properties: { name: 'Mauerpark', neighbourhood: 'Prenzlauer Berg' },
    };
    const ortsteil = {
      geometry: { coordinates: [13.42, 52.54] as [number, number] },
      properties: { name: 'Prenzlauer Berg', borough: 'Pankow' },
    };
    expect(
      pickBestFeature('Mauerpark, Prenzlauer Berg', [ortsteil, park]),
    ).toBe(park);
  });

  it('warns when the chosen hit does not account for the named place', () => {
    const w = matchWarning(query, wellness);
    expect(w).toContain('"Der Wellness Club, Berlin, Germany"');
    expect(w).toContain('"visionaere"');
    expect(matchWarning(query, visionaere)).toBeNull();
    // Address queries: street + house number are in the name.
    expect(
      matchWarning('Am Flutgraben 2, 12435 Berlin', {
        geometry: { coordinates: [13.451258, 52.496764] },
        properties: {
          name: 'Am Flutgraben 2',
          label: 'Am Flutgraben 2, Berlin, Germany',
          postalcode: '12435',
        },
      }),
    ).toBeNull();
  });

  it('geocode() resolves the venue and carries a warning only when doubtful', async () => {
    mockJson({ features: [visionaere, wellness] });
    const hit = await geocode(query);
    expect(hit).toMatchObject({ lat: 52.496796, lng: 13.45048 });
    expect(hit?.warning).toBeUndefined();

    mockJson({ features: [wellness] }); // the venue missing from the index
    expect((await geocode(query))?.warning).toMatch(
      /doesn't mention "visionaere"/,
    );
  });
});
