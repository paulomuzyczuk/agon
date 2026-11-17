import type { RecordingHeader } from '@/lib/liveRecordingDb';

// Save of a buffered recording (app/record/flushRecording.ts): a request that
// never got a response must say so (phone off the tailnet), not surface the
// browser's bare "Failed to fetch", and must leave the recording unflushed.

const markFlushed = jest.fn();
jest.mock('@/lib/liveRecordingDb', () => ({
  replayJournals: jest.fn().mockResolvedValue(0),
  stopRecording: jest.fn(),
  markFlushed: (...a: unknown[]) => markFlushed(...a),
  getGpsSamples: jest.fn().mockResolvedValue([]),
  getHrSamples: jest.fn().mockResolvedValue([{ tMs: 1, bpm: 140 }]),
  getSpeedSamples: jest.fn().mockResolvedValue([]),
  getCadenceSamples: jest.fn().mockResolvedValue([]),
  getPowerSamples: jest.fn().mockResolvedValue([]),
}));

import {
  flushRecording,
  UNREACHABLE_MESSAGE,
} from '@/app/record/flushRecording';

const header = {
  id: 'rec-1',
  startedAt: 1_760_000_000_000,
  endedAt: 1_760_000_060_000,
  status: 'stopped',
  activityType: 'run',
  deviceName: 'HRM 200',
} as unknown as RecordingHeader;

describe('flushRecording', () => {
  const realFetch = global.fetch;
  beforeEach(() => markFlushed.mockClear());
  afterAll(() => {
    global.fetch = realFetch;
  });

  it('explains an unreachable server and keeps the recording unflushed', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new TypeError('Failed to fetch')) as typeof fetch;
    await expect(flushRecording(header, 12)).rejects.toThrow(
      UNREACHABLE_MESSAGE,
    );
    expect(markFlushed).not.toHaveBeenCalled();
  });

  it('keeps the server message for an HTTP error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'authentication required' }),
    }) as unknown as typeof fetch;
    await expect(flushRecording(header, 12)).rejects.toThrow(
      'authentication required',
    );
    expect(markFlushed).not.toHaveBeenCalled();
  });

  it('marks the recording flushed on success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ runId: 'run-9' }),
    }) as unknown as typeof fetch;
    await expect(flushRecording(header, 12)).resolves.toEqual({
      activityType: 'run',
      id: 'run-9',
    });
    expect(markFlushed).toHaveBeenCalledWith('rec-1');
  });
});
