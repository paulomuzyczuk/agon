import { sendMessage, getUpdates, downloadFile } from '@/services/telegram/api';

// The Telegram Bot API client with `fetch` stubbed — asserts request shaping,
// envelope handling, and zod parsing. No network, no real token.

function mockFetch(body: unknown, status = 200): jest.Mock<Promise<Response>> {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

describe('sendMessage', () => {
  afterEach(() => jest.restoreAllMocks());

  it('POSTs chat_id + text to the sendMessage endpoint', async () => {
    const fetchMock = mockFetch({ ok: true, result: { message_id: 1 } });
    global.fetch = fetchMock as unknown as typeof fetch;

    await sendMessage(4242, 'hello there', 'TOKEN123');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.telegram.org/botTOKEN123/sendMessage');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      chat_id: 4242,
      text: 'hello there',
    });
  });

  it('throws with Telegram’s description when ok is false', async () => {
    global.fetch = mockFetch({
      ok: false,
      description: 'chat not found',
    }) as unknown as typeof fetch;

    await expect(sendMessage(1, 'x', 'TOKEN')).rejects.toThrow(
      /chat not found/,
    );
  });
});

describe('getUpdates', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends the offset and parses the update array', async () => {
    const fetchMock = mockFetch({
      ok: true,
      result: [
        { update_id: 10, message: { chat: { id: 7 }, text: '/week' } },
        { update_id: 11, message: { chat: { id: 7 } } }, // no text — still valid
      ],
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const updates = await getUpdates(10, 'TOKEN', 0);
    expect(updates).toHaveLength(2);
    expect(updates[0]!.message?.text).toBe('/week');
    expect(updates[1]!.message?.text).toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.telegram.org/botTOKEN/getUpdates');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      offset: 10,
      timeout: 0,
    });
  });
});

describe('downloadFile', () => {
  afterEach(() => jest.restoreAllMocks());

  it('resolves the file path via getFile then downloads the bytes', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: { file_path: 'voice/file_42.oga' },
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer,
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    const file = await downloadFile('FID', 'TOKEN');

    expect(file.filename).toBe('file_42.oga');
    expect([...file.bytes]).toEqual([9, 8, 7]);
    expect(file.mimeType).toBe('audio/ogg');
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.telegram.org/botTOKEN/getFile',
    );
    expect(fetchMock.mock.calls[1]![0]).toBe(
      'https://api.telegram.org/file/botTOKEN/voice/file_42.oga',
    );
  });
});
