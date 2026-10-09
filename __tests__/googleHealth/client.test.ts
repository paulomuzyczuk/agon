import {
  listExerciseSessionsPage,
  exportExerciseTcx,
  listDataPointsPage,
  GoogleHealthRateLimitError,
} from '@/services/googleHealth/client';

// The Google Health HTTP client with `fetch` stubbed — asserts request shaping,
// zod parsing of responses, and rate-limit handling. No network.

function mockFetch(
  status: number,
  body: unknown,
  text?: string,
): jest.Mock<Promise<Response>> {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: async () => body,
    text: async () => text ?? JSON.stringify(body),
  } as Response);
}

describe('listExerciseSessionsPage', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends paging UNFILTERED and parses the dataPoints envelope', async () => {
    const fetchMock = mockFetch(200, {
      dataPoints: [
        {
          name: 'users/me/dataTypes/exercise/dataPoints/abc',
          exercise: {
            interval: { startTime: '2026-07-24T06:00:00Z' },
            exerciseType: 'RUNNING',
          },
        },
      ],
      nextPageToken: 'tok2',
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await listExerciseSessionsPage('tok', {
      pageSize: 50,
      pageToken: 'tok1',
    });

    expect(out.dataPoints).toHaveLength(1);
    expect(out.nextPageToken).toBe('tok2');
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/users/me/dataTypes/exercise/dataPoints?');
    expect(url).toContain('pageSize=50');
    expect(url).toContain('pageToken=tok1');
    // No server-side filter: the exercise dataType exposes no comparable time
    // member (verified live 2026-08-01); the watermark is applied client-side.
    expect(url).not.toContain('filter');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok',
    );
  });

  it('defaults dataPoints to [] when the envelope omits it', async () => {
    global.fetch = mockFetch(200, {}) as unknown as typeof fetch;
    const out = await listExerciseSessionsPage('tok');
    expect(out.dataPoints).toEqual([]);
  });

  it('throws GoogleHealthRateLimitError on HTTP 429', async () => {
    global.fetch = mockFetch(429, {}) as unknown as typeof fetch;
    await expect(listExerciseSessionsPage('tok')).rejects.toBeInstanceOf(
      GoogleHealthRateLimitError,
    );
  });

  it('throws a generic error on other non-2xx responses', async () => {
    global.fetch = mockFetch(500, { error: 'boom' }) as unknown as typeof fetch;
    await expect(listExerciseSessionsPage('tok')).rejects.toThrow(
      /failed \(500/,
    );
  });

  it('rejects a payload that violates the schema', async () => {
    global.fetch = mockFetch(200, {
      dataPoints: [{ exercise: { exerciseType: 'RUNNING' } }], // missing interval
    }) as unknown as typeof fetch;
    await expect(listExerciseSessionsPage('tok')).rejects.toThrow();
  });
});

describe('exportExerciseTcx', () => {
  afterEach(() => jest.restoreAllMocks());

  it('GETs the :exportExerciseTcx sub-resource and unwraps the JSON tcxData', async () => {
    const xml =
      '<TrainingCenterDatabase><Activities/></TrainingCenterDatabase>';
    // Live shape: application/json body wrapping the TCX in `tcxData`.
    const fetchMock = mockFetch(200, {}, JSON.stringify({ tcxData: xml }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const name = 'users/me/dataTypes/exercise/dataPoints/abc';
    await expect(exportExerciseTcx('tok', name)).resolves.toBe(xml);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain(`/${name}:exportExerciseTcx`);
  });

  it('returns "" when the export has no tcxData (route-less run)', async () => {
    global.fetch = mockFetch(
      200,
      {},
      JSON.stringify({}),
    ) as unknown as typeof fetch;
    await expect(
      exportExerciseTcx('tok', 'users/me/dataTypes/exercise/dataPoints/x'),
    ).resolves.toBe('');
  });

  it('falls back to a raw-XML body if the response is not JSON', async () => {
    const xml = '<TrainingCenterDatabase/>';
    global.fetch = mockFetch(200, {}, xml) as unknown as typeof fetch;
    await expect(
      exportExerciseTcx('tok', 'users/me/dataTypes/exercise/dataPoints/x'),
    ).resolves.toBe(xml);
  });

  it('propagates a rate-limit error', async () => {
    global.fetch = mockFetch(429, {}) as unknown as typeof fetch;
    await expect(
      exportExerciseTcx('tok', 'users/me/dataTypes/exercise/dataPoints/x'),
    ).rejects.toBeInstanceOf(GoogleHealthRateLimitError);
  });
});

describe('listDataPointsPage', () => {
  afterEach(() => jest.restoreAllMocks());

  it('targets the given dataType and passes the filter + paging through', async () => {
    const fetchMock = mockFetch(200, {
      dataPoints: [
        { steps: { interval: { startTime: '2026-07-24T10:00:00Z' } } },
      ],
      nextPageToken: 'next',
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const out = await listDataPointsPage('tok', {
      dataType: 'steps',
      filter: 'steps.interval.start_time >= "2026-07-24T00:00:00Z"',
      pageSize: 500,
      pageToken: 'p1',
    });
    expect(out.dataPoints).toHaveLength(1);
    expect(out.nextPageToken).toBe('next');
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/users/me/dataTypes/steps/dataPoints?');
    expect(url).toContain('pageSize=500');
    expect(url).toContain('pageToken=p1');
    expect(decodeURIComponent(url)).toContain('steps.interval.start_time');
  });

  it('defaults dataPoints to [] when omitted', async () => {
    global.fetch = mockFetch(200, {}) as unknown as typeof fetch;
    const out = await listDataPointsPage('tok', { dataType: 'sleep' });
    expect(out.dataPoints).toEqual([]);
  });

  it('throws GoogleHealthRateLimitError on HTTP 429', async () => {
    global.fetch = mockFetch(429, {}) as unknown as typeof fetch;
    await expect(
      listDataPointsPage('tok', { dataType: 'sleep' }),
    ).rejects.toBeInstanceOf(GoogleHealthRateLimitError);
  });
});
