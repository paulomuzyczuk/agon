import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { loadEnv } from './loadEnv';
import { query, closeDbPool } from '../services/db';
import { insertBodyMetric } from '../services/bodyMetrics';
import { getCompletionClient, completionConfigFromEnv } from '../services/llm';
import { ingestVoiceNote } from '../services/voice/ingest';
import type { CaptureType } from '../services/voice/schemas';
import { logger } from '../services/logger';

// Replay a Telegram Desktop chat export (JSON) of the Agon bot chat into the DB —
// the recovery path for captures lost with the database (the Bot API has no
// history endpoint, so an export is the only complete copy).
//
// What is replayed, and from where:
//   - /weight and /bf commands → body_metrics, dated with the date the BOT
//     reported in its "✅ Logged … (YYYY-MM-DD)" reply (exactly what was stored).
//   - Voice notes → the transcript quoted in the bot's "Logged … note" reply,
//     re-run through ingestVoiceNote (LLM parse → qualitative_logs → fan-out).
//     Reusing the original transcript restores what was stored without a second
//     transcription pass. Capture type comes from the reply's emoji.
// Everything else (unknown commands, /route, free text) is skipped.
//
// A voice note's capture date defaults to the athlete-local date of the bot's
// reply. Notes recorded about an earlier day ("yesterday's half marathon") can be
// pinned with --date=<replyMessageId>:YYYY-MM-DD — the fan-out attaches a note to
// the run on that date, so the right date matters.
//
// Idempotent: a body metric already present (same date + value) and a note
// whose transcript already exists in qualitative_logs are skipped.
//
//   pnpm tsx scripts/import-telegram-export.ts <exportDir> [--date=ID:DATE ...]            DRY RUN
//   pnpm tsx scripts/import-telegram-export.ts <exportDir> [--date=ID:DATE ...] --write

const textPart = z.union([
  z.string(),
  z.object({ text: z.string() }).passthrough(),
]);
const messageSchema = z
  .object({
    id: z.number(),
    type: z.string(),
    date: z.string(),
    from: z.string().optional(),
    text: z.union([z.string(), z.array(textPart)]).optional(),
  })
  .passthrough();
const exportSchema = z.object({ messages: z.array(messageSchema) });

function plainText(t: z.infer<typeof messageSchema>['text']): string {
  if (t === undefined) return '';
  if (typeof t === 'string') return t;
  return t.map((p) => (typeof p === 'string' ? p : p.text)).join('');
}

/** Athlete-local calendar date of a Telegram export timestamp (already local). */
function exportDate(iso: string): string {
  return iso.slice(0, 10);
}

type Replay =
  | { kind: 'weight' | 'bf'; replyId: number; date: string; value: number }
  | {
      kind: 'voice';
      replyId: number;
      date: string;
      captureType: CaptureType;
      transcript: string;
    };

const VOICE_REPLY = /^(🏃|🏋️|⚖️) Logged/u;
const CAPTURE_BY_EMOJI: Record<string, CaptureType> = {
  '🏃': 'run',
  '🏋️': 'lift',
  '⚖️': 'body',
};

function planReplays(
  messages: z.infer<typeof messageSchema>[],
  dateOverrides: Map<number, string>,
): Replay[] {
  const out: Replay[] = [];
  for (const m of messages) {
    if (m.type !== 'message' || m.from === undefined) continue;
    const text = plainText(m.text);
    const weight = text.match(
      /^✅ Logged weight ([\d.]+) kg \((\d{4}-\d{2}-\d{2})\)/,
    );
    if (weight) {
      out.push({
        kind: 'weight',
        replyId: m.id,
        date: weight[2]!,
        value: Number(weight[1]),
      });
      continue;
    }
    const bf = text.match(
      /^✅ Logged body fat ([\d.]+)% \((\d{4}-\d{2}-\d{2})\)/,
    );
    if (bf) {
      out.push({
        kind: 'bf',
        replyId: m.id,
        date: bf[2]!,
        value: Number(bf[1]),
      });
      continue;
    }
    const voice = text.match(VOICE_REPLY);
    const quoted = text.match(/📝 “([\s\S]*)”\s*$/u);
    if (voice && quoted) {
      out.push({
        kind: 'voice',
        replyId: m.id,
        date: dateOverrides.get(m.id) ?? exportDate(m.date),
        captureType: CAPTURE_BY_EMOJI[voice[1]!]!,
        transcript: quoted[1]!.trim(),
      });
    }
  }
  return out;
}

async function alreadyImported(r: Replay): Promise<boolean> {
  if (r.kind === 'voice') {
    const { rows } = await query<{ n: string }>(
      `SELECT count(*) AS n FROM public.qualitative_logs WHERE raw_transcript = $1`,
      [r.transcript],
    );
    return Number(rows[0]!.n) > 0;
  }
  const column = r.kind === 'weight' ? 'weight_kg' : 'body_fat_pct';
  const { rows } = await query<{ n: string }>(
    `SELECT count(*) AS n FROM public.body_metrics
      WHERE date = $1 AND ${column} = $2 AND notes = 'telegram export'`,
    [r.date, r.value],
  );
  return Number(rows[0]!.n) > 0;
}

function parseOverrides(args: string[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const a of args.filter((x) => x.startsWith('--date='))) {
    const m = a.slice('--date='.length).match(/^(\d+):(\d{4}-\d{2}-\d{2})$/);
    if (!m)
      throw new Error(
        `import-telegram-export: bad override '${a}' (want --date=ID:YYYY-MM-DD)`,
      );
    map.set(Number(m[1]), m[2]!);
  }
  return map;
}

async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir)
    throw new Error('import-telegram-export: pass the export directory');
  logger.info('starting telegram export import', {
    job: 'telegram-export',
    write,
  });

  const data = exportSchema.parse(
    JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')),
  );
  const replays = planReplays(data.messages, parseOverrides(args));
  const llm = write ? getCompletionClient(completionConfigFromEnv()) : null;

  const lines: string[] = [
    '',
    `Telegram export replay (${replays.length} capture(s)):`,
  ];
  let applied = 0;
  for (const r of replays) {
    const label =
      r.kind === 'voice'
        ? `${r.captureType} note  “${r.transcript.slice(0, 60)}…”`
        : `${r.kind} ${r.value}`;
    if (await alreadyImported(r)) {
      lines.push(
        `  #${r.replyId}  ${r.date}  ${label}  → skip (already imported)`,
      );
      continue;
    }
    if (!write) {
      lines.push(`  #${r.replyId}  ${r.date}  ${label}  → would import`);
      continue;
    }
    if (r.kind === 'voice') {
      const res = await ingestVoiceNote(llm!, {
        captureType: r.captureType,
        transcript: r.transcript,
        capturedDate: r.date,
      });
      const run = res.run
        ? ` run=${res.run.runId?.slice(0, 8) ?? 'unlinked'}${res.run.runCreated ? ' (created)' : ''}` +
          ` fueling=${res.run.fuelingItemsInserted}` +
          (res.run.unmatchedProducts.length
            ? ` unmatched=[${res.run.unmatchedProducts.join(', ')}]`
            : '')
        : '';
      lines.push(
        `  #${r.replyId}  ${res.effectiveDate}  ${label}  → imported${run}`,
      );
    } else {
      await insertBodyMetric({
        date: r.date,
        weightKg: r.kind === 'weight' ? r.value : null,
        bodyFatPct: r.kind === 'bf' ? r.value : null,
        notes: 'telegram export',
      });
      lines.push(`  #${r.replyId}  ${r.date}  ${label}  → imported`);
    }
    applied++;
  }
  lines.push(
    '',
    write
      ? `WROTE ${applied} capture(s).`
      : 'DRY RUN — no changes written. Re-run with --write to apply.',
  );
  console.log(lines.join('\n'));
}

main()
  .catch((err) => {
    logger.error('telegram export import failed', {
      job: 'telegram-export',
      err,
    });
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
