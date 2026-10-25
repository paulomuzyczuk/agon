import {
  trimEnds,
  buildCrossingsQuery,
  parseCrossingCounts,
  countCrossings,
} from '@/services/routing/crossings';

// Overpass crossing counter — pure parts directly, the client with an injected
// fetch. No network.

// A straight line north from a fictional start, one point every ~11 m (0.0001°
// of latitude), 2 km long.
const START = [13.0, 50.0];
const line = Array.from({ length: 181 }, (_, i) => [
  START[0]!,
  START[1]! + i * 0.0001,
]);

const countsBody = (signals: number, plain: number) =>
  JSON.stringify({
    elements: [
      {
        type: 'count',
        id: 0,
        tags: { nodes: String(signals), ways: '0', total: String(signals) },
      },
      {
        type: 'count',
        id: 0,
        tags: { nodes: String(plain), ways: '0', total: String(plain) },
      },
    ],
  });

function response(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as Response;
}

describe('trimEnds', () => {
  it('drops about 300 m at each end', () => {
    const kept = trimEnds(line);
    // ~2 km line, 11.1 m per step: ~27 points trimmed per end.
    expect(kept.length).toBeGreaterThan(120);
    expect(kept.length).toBeLessThan(130);
    expect(kept[0]![1]! - START[1]!).toBeGreaterThan(0.0026); // ≥ ~290 m
  });

  it('leaves nothing of a line shorter than both trims', () => {
    expect(trimEnds(line.slice(0, 40))).toEqual([]);
  });
});

describe('buildCrossingsQuery', () => {
  it('never includes a point within 300 m of the start or finish (home)', () => {
    const loop = [...line, ...[...line].reverse()]; // out and back to the start
    const q = buildCrossingsQuery(loop)!;
    const lats = [...q.matchAll(/(\d+\.\d{5}),13\.00000/g)].map((m) =>
      Number(m[1]),
    );
    expect(lats.length).toBeGreaterThan(0);
    for (const lat of lats) expect(lat - START[1]!).toBeGreaterThan(0.0026);
  });

  it('thins long routes to at most 150 query points', () => {
    const long = Array.from({ length: 2000 }, (_, i) => [
      13.0,
      50.0 + i * 0.0001,
    ]);
    const q = buildCrossingsQuery(long)!;
    const firstAround = q.match(/around:12,([^)]*)\)/)![1]!;
    expect(firstAround.split(',').length / 2).toBeLessThanOrEqual(150);
  });

  it('returns null when nothing survives the trim', () => {
    expect(buildCrossingsQuery(line.slice(0, 40))).toBeNull();
  });
});

describe('parseCrossingCounts', () => {
  it('reads signals then plain crossings', () => {
    expect(parseCrossingCounts(JSON.parse(countsBody(3, 7)))).toEqual({
      trafficSignals: 3,
      plainCrossings: 7,
    });
  });

  it('rejects any other shape', () => {
    expect(() => parseCrossingCounts({ elements: [] })).toThrow();
    expect(() => parseCrossingCounts({ remark: 'runtime error' })).toThrow();
  });
});

describe('countCrossings', () => {
  const noSleep = async () => {};
  const original = process.env.ROUTING_CROSSINGS;
  afterEach(() => {
    if (original === undefined) delete process.env.ROUTING_CROSSINGS;
    else process.env.ROUTING_CROSSINGS = original;
  });

  it('POSTs the query with an identifying User-Agent', async () => {
    const fetchFn = jest.fn(async () => response(200, countsBody(1, 2)));
    const counts = await countCrossings(line, {
      fetchFn: fetchFn as never,
      sleep: noSleep,
    });
    expect(counts).toEqual({ trafficSignals: 1, plainCrossings: 2 });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toMatch(/\/interpreter$/);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['User-Agent']).toMatch(
      /^agon-route-builder/,
    );
  });

  it('retries an overloaded Overpass (429, or a 200 HTML error page)', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(response(429, 'Too Many Requests'))
      .mockResolvedValueOnce(response(200, '<html>timeout</html>'))
      .mockResolvedValueOnce(response(200, countsBody(0, 4)));
    expect(await countCrossings(line, { fetchFn, sleep: noSleep })).toEqual({
      trafficSignals: 0,
      plainCrossings: 4,
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('gives up with null, never throwing, when every attempt fails', async () => {
    const fetchFn = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    expect(await countCrossings(line, { fetchFn, sleep: noSleep })).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('treats a malformed JSON answer as a failure, not a count', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValue(response(200, '{"elements":[]}'));
    expect(await countCrossings(line, { fetchFn, sleep: noSleep })).toBeNull();
  });

  it('does nothing when disabled', async () => {
    process.env.ROUTING_CROSSINGS = '0';
    const fetchFn = jest.fn();
    expect(await countCrossings(line, { fetchFn, sleep: noSleep })).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
