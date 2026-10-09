import { spawn } from 'child_process';
import { z } from 'zod';
import type {
  CompletionClientConfig,
  LlmCompletionClient,
  StructuredCompletionRequest,
} from '../completion';
import { extractJson } from '../json';

// Completion via the local `claude` CLI instead of the metered Anthropic API —
// the same approach the pygmalion project uses. Runs `claude -p` as a subprocess,
// which bills against the machine's Claude subscription (Claude Code login), so
// voice-note parsing costs no per-token API credits. Structured output is still
// OUR contract: we ask for JSON in the prompt and validate with the caller's zod
// schema — no provider feature. The injectable runner keeps the unit lane free of
// a real `claude` process.
//
// `--output-format json` wraps the reply in an envelope; the model's text is in
// `.result`. `--dangerously-skip-permissions` is safe here: `-p` is a single,
// non-interactive, text-only turn (our prompts request JSON, never tool use), and
// the flag just guarantees it can't stall waiting on a permission prompt.

const cliEnvelopeSchema = z.object({
  is_error: z.boolean().optional(),
  subtype: z.string().optional(),
  result: z.string().optional(),
});

export interface ClaudeCliRunOptions {
  claudeBin: string;
  model?: string;
  system: string;
  user: string;
}

/** Run `claude -p` and resolve to its raw stdout (the JSON envelope). */
export type ClaudeCliRunner = (opts: ClaudeCliRunOptions) => Promise<string>;

export const defaultClaudeCliRunner: ClaudeCliRunner = (opts) =>
  new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
      '--system-prompt',
      opts.system,
    ];
    if (opts.model) args.push('--model', opts.model);
    args.push(opts.user); // the user turn is the trailing positional

    const proc = spawn(opts.claudeBin, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.on('error', (err) =>
      reject(
        new Error(
          `claude cli: could not start '${opts.claudeBin}' (${err.message}) — ` +
            `is Claude Code installed and logged in?`,
        ),
      ),
    );
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude cli: exited ${code}: ${stderr.trim()}`));
    });
  });

export class ClaudeCliCompletionClient implements LlmCompletionClient {
  private readonly claudeBin: string;
  private readonly model?: string;

  constructor(
    config: CompletionClientConfig,
    private readonly runner: ClaudeCliRunner = defaultClaudeCliRunner,
  ) {
    this.claudeBin = config.claudeBin || 'claude';
    this.model = config.model || undefined;
  }

  async complete<S extends z.ZodTypeAny>(
    req: StructuredCompletionRequest<S>,
  ): Promise<z.output<S>> {
    const stdout = await this.runner({
      claudeBin: this.claudeBin,
      model: this.model,
      system: req.prompt.system,
      user: req.prompt.buildUser(req.input),
    });

    const envelope = cliEnvelopeSchema.parse(JSON.parse(stdout));
    if (envelope.is_error || !envelope.result) {
      throw new Error(
        `claude cli: completion failed (subtype: ${envelope.subtype ?? 'unknown'})`,
      );
    }
    // Validate the model's JSON against the caller's schema — same boundary as
    // every other adapter.
    return req.schema.parse(extractJson(envelope.result));
  }
}
