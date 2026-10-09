import { orsFetch, OrsRateLimitError } from '@/services/routing/client';

// orsFetch error mapping. An exhausted daily ORS quota is a 403 with
// {"error":"Quota exceeded"} (seen 2026-09-25, MZY-215) — callers must see it
// as a rate limit so the directions fallback engages.

const OLD_ENV = process.env;
beforeEach(() => {
  process.env = { ...OLD_ENV, ORS_API_KEY: 'test-key' };
});
afterEach(() => {
  process.env = OLD_ENV;
  jest.restoreAllMocks();
});

function mockStatus(status: number, body: string) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: 'x',
    text: async () => body,
  } as Response) as unknown as typeof fetch;
}

describe('orsFetch', () => {
  it('maps 429 to OrsRateLimitError', async () => {
    mockStatus(429, 'slow down');
    await expect(orsFetch('/v2/x')).rejects.toBeInstanceOf(OrsRateLimitError);
  });

  it('maps a 403 quota-exceeded body to OrsRateLimitError', async () => {
    mockStatus(403, '{"error":"Quota exceeded"}');
    await expect(orsFetch('/v2/x')).rejects.toBeInstanceOf(OrsRateLimitError);
  });

  it('keeps any other 403 a plain error (e.g. a bad key)', async () => {
    mockStatus(403, '{"error":"Access to this API has been disallowed"}');
    const err = await orsFetch('/v2/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OrsRateLimitError);
  });
});
