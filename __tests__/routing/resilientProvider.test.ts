import {
  withDirectionsCache,
  withDirectionsFallback,
} from '@/services/routing/resilientProvider';
import { OrsRateLimitError } from '@/services/routing/client';
import type { RouteProvider } from '@/services/routing/provider';
import type { RouteCandidate } from '@/services/routing/types';

// Directions fallback + cache decorators (MZY-215). No network.

const route = (provider: string): RouteCandidate => ({
  seed: 0,
  distanceM: 1000,
  elevationGainM: null,
  coordinates: [],
  provider,
});

function stub(name: string, directions: jest.Mock): RouteProvider {
  return {
    name,
    generateRoundTrips: jest.fn().mockResolvedValue([route(name)]),
    directions,
  };
}

const WPS = [
  { lat: 52.5, lng: 13.4 },
  { lat: 52.51, lng: 13.41 },
];

describe('withDirectionsFallback', () => {
  it('uses the fallback once the primary is out of quota, and stays there', async () => {
    const primary = jest
      .fn()
      .mockRejectedValue(new OrsRateLimitError('quota exceeded'));
    const fallback = jest.fn().mockResolvedValue(route('osrm'));
    const p = withDirectionsFallback(
      stub('ors', primary),
      stub('osrm', fallback),
    );
    expect((await p.directions(WPS)).provider).toBe('osrm');
    await p.directions(WPS);
    expect(primary).toHaveBeenCalledTimes(1); // not asked again
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it('rethrows non-quota errors', async () => {
    const primary = jest.fn().mockRejectedValue(new Error('bad request'));
    const fallback = jest.fn();
    const p = withDirectionsFallback(
      stub('ors', primary),
      stub('osrm', fallback),
    );
    await expect(p.directions(WPS)).rejects.toThrow('bad request');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('keeps round trips on the primary', async () => {
    const primary = stub('ors', jest.fn());
    const p = withDirectionsFallback(primary, stub('osrm', jest.fn()));
    await p.generateRoundTrips({ targetKm: 5, start: WPS[0]! });
    expect(primary.generateRoundTrips).toHaveBeenCalled();
  });
});

describe('withDirectionsCache', () => {
  it('serves identical requests from cache, per profile', async () => {
    const inner = jest.fn().mockResolvedValue(route('ors'));
    const p = withDirectionsCache(stub('ors', inner));
    await p.directions(WPS, 'foot-walking');
    await p.directions([...WPS], 'foot-walking');
    await p.directions(WPS, 'cycling-regular');
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('keys the cache on the hill preference too', async () => {
    const inner = jest.fn().mockResolvedValue(route('ors'));
    const p = withDirectionsCache(stub('ors', inner));
    await p.directions(WPS, 'cycling-road', 'flat');
    await p.directions(WPS, 'cycling-road', 'flat');
    await p.directions(WPS, 'cycling-road', 'hilly');
    await p.directions(WPS, 'cycling-road');
    expect(inner).toHaveBeenCalledTimes(3);
    expect(inner).toHaveBeenCalledWith(WPS, 'cycling-road', 'flat');
  });

  it('evicts the oldest entry past the size cap', async () => {
    const inner = jest.fn().mockResolvedValue(route('ors'));
    const p = withDirectionsCache(stub('ors', inner), 1);
    await p.directions(WPS);
    await p.directions([WPS[1]!, WPS[0]!]);
    await p.directions(WPS);
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it('does not cache failures', async () => {
    const inner = jest
      .fn()
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValue(route('ors'));
    const p = withDirectionsCache(stub('ors', inner));
    await expect(p.directions(WPS)).rejects.toThrow('flaky');
    await expect(p.directions(WPS)).resolves.toMatchObject({ provider: 'ors' });
  });
});
