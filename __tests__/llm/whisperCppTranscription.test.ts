import { readFile } from 'fs/promises';
import {
  WhisperCppTranscriptionClient,
  type WhisperCppRunner,
} from '@/services/llm/adapters/whisperCppTranscription';

// The ffmpeg + whisper.cpp subprocess is replaced by an injected runner, so this
// exercises the adapter plumbing — temp-file write, arg wiring, stdout → text,
// cleanup — with no ffmpeg, no whisper.cpp binary, and no model.

describe('WhisperCppTranscriptionClient', () => {
  it('writes audio to a temp file, runs the bridge, and returns trimmed text', async () => {
    const audio = new Uint8Array([9, 8, 7]);
    let seen: {
      path: string;
      model: string;
      bin: string;
      lang?: string;
    } | null = null;
    const runner: WhisperCppRunner = async (audioPath, opts) => {
      seen = {
        path: audioPath,
        model: opts.model,
        bin: opts.whisperBin,
        lang: opts.language,
      };
      expect([...(await readFile(audioPath))]).toEqual([9, 8, 7]);
      expect(audioPath.endsWith('.ogg')).toBe(true);
      return '  ran twelve k, felt strong  \n';
    };

    const client = new WhisperCppTranscriptionClient(
      {
        provider: 'whisper-cpp',
        model: '/opt/whisper/ggml-medium.bin',
        whisperBin: 'whisper-cli',
      },
      runner,
    );
    const out = await client.transcribe({
      audio,
      filename: 'voice.ogg',
      mimeType: 'audio/ogg',
      language: 'en',
    });

    expect(out.text).toBe('ran twelve k, felt strong'); // trimmed
    expect(seen).toMatchObject({
      model: '/opt/whisper/ggml-medium.bin',
      bin: 'whisper-cli',
      lang: 'en',
    });
    await expect(readFile(seen!.path)).rejects.toThrow(); // temp cleaned up
  });

  it('defaults the whisper binary + model when unset', async () => {
    let seenBin = '';
    let seenModel = '';
    const runner: WhisperCppRunner = async (_p, opts) => {
      seenBin = opts.whisperBin;
      seenModel = opts.model;
      return 'ok';
    };
    await new WhisperCppTranscriptionClient(
      { provider: 'whisper-cpp', model: '' },
      runner,
    ).transcribe({
      audio: new Uint8Array([1]),
      filename: 'a.ogg',
      mimeType: 'audio/ogg',
    });
    expect(seenBin).toBe('whisper-cli');
    expect(seenModel).toBe('models/ggml-medium.bin');
  });
});
