import {
  formatVia,
  buildRouteLabel,
  describeRouteVia,
} from '@/services/routing/routeDescription';
import * as geocode from '@/services/routing/geocode';

describe('formatVia', () => {
  it('formats 0/1/2/3 names as a readable list', () => {
    expect(formatVia([])).toBe('');
    expect(formatVia(['Tempelhof'])).toBe('Tempelhof');
    expect(formatVia(['Tempelhof', 'Schöneberg'])).toBe(
      'Tempelhof and Schöneberg',
    );
    expect(formatVia(['Südkreuz', 'Tempelhof', 'Kudamm'])).toBe(
      'Südkreuz, Tempelhof and Kudamm',
    );
  });
});

describe('buildRouteLabel', () => {
  it('uses place names when available', () => {
    expect(buildRouteLabel(1, 8.34, ['Tempelhof', 'Schöneberg'], 'N')).toBe(
      'Route 1 · 8.3 km — Tempelhof and Schöneberg',
    );
  });
  it('falls back to compass direction when no places', () => {
    expect(buildRouteLabel(2, 8.34, [], 'E')).toBe(
      'Route 2 · 8.3 km · heading E',
    );
  });
  it('falls back to just distance when nothing is known', () => {
    expect(buildRouteLabel(3, 8.34, [])).toBe('Route 3 · 8.3 km');
  });
  it('marks a one-way route', () => {
    expect(buildRouteLabel(1, 20.4, ['Grunewald', 'Steglitz'], 'S', true)).toBe(
      'Route 1 · 20.4 km one-way — Grunewald and Steglitz',
    );
  });
});

describe('describeRouteVia', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reverse-geocodes sampled points and dedupes area names in path order', async () => {
    const spy = jest
      .spyOn(geocode, 'reverseGeocode')
      .mockResolvedValueOnce('Tempelhof')
      .mockResolvedValueOnce('Tempelhof') // dupe → dropped
      .mockResolvedValueOnce('Schöneberg');
    const coords = Array.from({ length: 10 }, (_, i) => [
      13.32 + i * 0.001,
      52.49,
    ]);
    const via = await describeRouteVia(coords);
    expect(via).toEqual(['Tempelhof', 'Schöneberg']);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('skips a failed lookup without throwing', async () => {
    jest
      .spyOn(geocode, 'reverseGeocode')
      .mockResolvedValueOnce('Kreuzberg')
      .mockRejectedValueOnce(new Error('rate limit'))
      .mockResolvedValueOnce('Neukölln');
    const coords = Array.from({ length: 10 }, (_, i) => [
      13.32 + i * 0.001,
      52.49,
    ]);
    const via = await describeRouteVia(coords);
    expect(via).toEqual(['Kreuzberg', 'Neukölln']);
  });
});
