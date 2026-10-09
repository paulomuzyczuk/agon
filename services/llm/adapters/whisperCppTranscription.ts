import { spawn } from 'child_process';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, extname } from 'path';
import type {
  TranscriptionClient,
  TranscriptionClientConfig,
  TranscriptionRequest,
  TranscriptionResult,
} from '../transcription';

// Local, offline speech-to-text via whisper.cpp — the free/open-source STT path
// on the self-hosted Linux tower (mlx-whisper is Apple-Silicon-only). Mirrors the
// mlx adapter: write the audio to a temp file, shell out to a small bridge script
// (scripts/whisper_cpp_transcribe.sh: ffmpeg → 16 kHz WAV → whisper.cpp CLI), and
// read the transcript off stdout. Raw audio never leaves the machine, no API cost.
// The injectable `runner` seam lets the unit lane exercise the plumbing without
// ffmpeg, the whisper.cpp binary, or a model download.
//
// `config.model` is the path to a whisper.cpp GGML/GGUF model file
// (e.g. /opt/whisper/models/ggml-medium.bin); `whisperBin` is the CLI
// (default 'whisper-cli'). Build whisper.cpp with -DGGML_CUDA=1 to use the GPU.

const DEFAULT_MODEL = 'models/ggml-medium.bin';

export interface WhisperCppRunOptions {
  scriptPath: string;
  model: string;
  whisperBin: string;
  language?: string;
}

/** Run the bridge script on an audio file; resolve to its raw stdout (transcript). */
export type WhisperCppRunner = (
  audioPath: string,
  opts: WhisperCppRunOptions,
) => Promise<string>;

/** Default runner: spawn the bash bridge script. */
export const defaultWhisperCppRunner: WhisperCppRunner = (audioPath, opts) =>
  new Promise((resolve, reject) => {
    const args = [
      opts.scriptPath,
      audioPath,
      opts.model,
      opts.whisperBin,
      opts.language ?? 'auto',
    ];
    const proc = spawn('bash', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.on('error', (err) =>
      reject(
        new Error(
          `whisper.cpp transcription: could not run the bridge script (${err.message}) — ` +
            `are bash, ffmpeg and whisper.cpp installed?`,
        ),
      ),
    );
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(
            `whisper.cpp transcription: exited ${code}: ${stderr.trim()}`,
          ),
        );
    });
  });

export class WhisperCppTranscriptionClient implements TranscriptionClient {
  private readonly model: string;
  private readonly whisperBin: string;
  private readonly scriptPath: string;

  constructor(
    config: TranscriptionClientConfig,
    private readonly runner: WhisperCppRunner = defaultWhisperCppRunner,
  ) {
    this.model = config.model || DEFAULT_MODEL;
    this.whisperBin = config.whisperBin || 'whisper-cli';
    this.scriptPath =
      config.scriptPath ||
      join(process.cwd(), 'scripts', 'whisper_cpp_transcribe.sh');
  }

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    // Preserve the extension so ffmpeg sniffs the input format correctly.
    const ext = extname(req.filename) || '.ogg';
    const dir = await mkdtemp(join(tmpdir(), 'agon-voice-'));
    const audioPath = join(dir, `note${ext}`);
    try {
      await writeFile(audioPath, req.audio);
      const stdout = await this.runner(audioPath, {
        scriptPath: this.scriptPath,
        model: this.model,
        whisperBin: this.whisperBin,
        language: req.language,
      });
      // The script prints the raw transcript (no JSON wrapper) to stdout.
      return { text: stdout.trim() };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
