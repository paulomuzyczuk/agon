import { spawn } from 'child_process';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, extname } from 'path';
import { z } from 'zod';
import type {
  TranscriptionClient,
  TranscriptionClientConfig,
  TranscriptionRequest,
  TranscriptionResult,
} from '../transcription';

// Local, offline speech-to-text via Apple's MLX Whisper — the same stack the
// pygmalion project uses. mlx-whisper is a Python library, so the bridge is a
// short Python transcriber (scripts/mlx_transcribe.py) that this adapter shells
// out to: write the audio to a temp file, run the script, read {"text": ...} off
// stdout. Raw audio never leaves the machine and there are no API costs. The
// injectable `runner` seam lets the unit lane exercise all the plumbing without
// Python, mlx, or a model download.

const DEFAULT_MODEL = 'mlx-community/whisper-medium-mlx';

const responseSchema = z.object({ text: z.string() });

export interface MlxRunOptions {
  pythonBin: string;
  scriptPath: string;
  model: string;
}

/** Run the Python transcriber on an audio file; resolve to its raw stdout. */
export type MlxRunner = (
  audioPath: string,
  opts: MlxRunOptions,
) => Promise<string>;

/** Default runner: spawn `python3 scripts/mlx_transcribe.py <audio> --model M`. */
export const defaultMlxRunner: MlxRunner = (audioPath, opts) =>
  new Promise((resolve, reject) => {
    const proc = spawn(opts.pythonBin, [
      opts.scriptPath,
      audioPath,
      '--model',
      opts.model,
    ]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.on('error', (err) =>
      reject(
        new Error(
          `mlx transcription: could not start '${opts.pythonBin}' (${err.message}) — ` +
            `is Python installed and mlx-whisper set up? See scripts/requirements-transcription.txt`,
        ),
      ),
    );
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(
            `mlx transcription: transcriber exited ${code}: ${stderr.trim()}`,
          ),
        );
    });
  });

export class MlxWhisperTranscriptionClient implements TranscriptionClient {
  private readonly model: string;
  private readonly pythonBin: string;
  private readonly scriptPath: string;

  constructor(
    config: TranscriptionClientConfig,
    private readonly runner: MlxRunner = defaultMlxRunner,
  ) {
    this.model = config.model || DEFAULT_MODEL;
    this.pythonBin = config.pythonBin || 'python3';
    this.scriptPath =
      config.scriptPath || join(process.cwd(), 'scripts', 'mlx_transcribe.py');
  }

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    // Preserve the extension so ffmpeg/whisper sniff the format correctly.
    const ext = extname(req.filename) || '.ogg';
    const dir = await mkdtemp(join(tmpdir(), 'agon-voice-'));
    const audioPath = join(dir, `note${ext}`);
    try {
      await writeFile(audioPath, req.audio);
      const stdout = await this.runner(audioPath, {
        pythonBin: this.pythonBin,
        scriptPath: this.scriptPath,
        model: this.model,
      });
      return responseSchema.parse(JSON.parse(stdout));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
