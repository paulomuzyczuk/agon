import { readFile } from 'fs/promises';
import {
  MlxWhisperTranscriptionClient,
  type MlxRunner,
} from '@/services/llm/adapters/mlxWhisperTranscription';

// The Python/mlx subprocess is replaced by an injected runner, so this exercises
// all the adapter plumbing — temp-file write, arg wiring, stdout parse, cleanup —
// with no Python, no model, and no network.

describe('MlxWhisperTranscriptionClient', () => {
  it('writes the audio to a temp file, runs the model, and returns the text', async () => {
    const audio = new Uint8Array([1, 2, 3, 4]);
    let seenPath = '';
    let seenModel = '';
    const runner: MlxRunner = async (audioPath, opts) => {
      seenPath = audioPath;
      seenModel = opts.model;
      // The adapter must have written our bytes to this path before calling us.
      expect([...(await readFile(audioPath))]).toEqual([1, 2, 3, 4]);
      expect(audioPath.endsWith('.ogg')).toBe(true); // extension preserved
      return '{"text": "ran ten k, knee felt fine at seven"}';
    };

    const client = new MlxWhisperTranscriptionClient(
      { provider: 'mlx-whisper', model: 'mlx-community/whisper-medium-mlx' },
      runner,
    );
    const out = await client.transcribe({
      audio,
      filename: 'voice.ogg',
      mimeType: 'audio/ogg',
    });

    expect(out.text).toBe('ran ten k, knee felt fine at seven');
    expect(seenModel).toBe('mlx-community/whisper-medium-mlx');
    // The temp dir is cleaned up in a finally — the file must be gone.
    await expect(readFile(seenPath)).rejects.toThrow();
  });

  it('falls back to the default model when none is configured', async () => {
    let seenModel = '';
    const runner: MlxRunner = async (_audioPath, opts) => {
      seenModel = opts.model;
      return '{"text": "ok"}';
    };
    const client = new MlxWhisperTranscriptionClient(
      { provider: 'mlx-whisper', model: '' },
      runner,
    );
    await client.transcribe({
      audio: new Uint8Array([0]),
      filename: 'a.m4a',
      mimeType: 'audio/mp4',
    });
    expect(seenModel).toBe('mlx-community/whisper-medium-mlx');
  });

  it('cleans up even when the runner fails', async () => {
    let seenPath = '';
    const runner: MlxRunner = async (audioPath) => {
      seenPath = audioPath;
      throw new Error('boom');
    };
    const client = new MlxWhisperTranscriptionClient(
      { provider: 'mlx-whisper', model: 'm' },
      runner,
    );
    await expect(
      client.transcribe({
        audio: new Uint8Array([0]),
        filename: 'a.wav',
        mimeType: 'audio/wav',
      }),
    ).rejects.toThrow('boom');
    await expect(readFile(seenPath)).rejects.toThrow(); // temp still cleaned
  });

  it('throws on stdout that is not valid JSON of the expected shape', async () => {
    const runner: MlxRunner = async () => 'not json';
    const client = new MlxWhisperTranscriptionClient(
      { provider: 'mlx-whisper', model: 'm' },
      runner,
    );
    await expect(
      client.transcribe({
        audio: new Uint8Array([0]),
        filename: 'a.wav',
        mimeType: 'audio/wav',
      }),
    ).rejects.toThrow();
  });
});
