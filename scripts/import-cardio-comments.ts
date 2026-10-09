import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { loadEnv } from './loadEnv';
import { query, closeDbPool } from '../services/db';
import { insertQualitativeLog } from '../services/qualitativeLogs';
import { logger } from '../services/logger';

// Import the free-text "Comment" column of the athlete's "Event Logging" ›
// "Cardio" spreadsheet into public.qualitative_logs — the per-run context
// (strap failures, pain, heat, hangovers, stops) that no activity API carries.
// One qualitative_logs row per commented sheet row, session_type 'run', the
// comment verbatim as raw_transcript, and the sheet's own numbers + the matched
// run (by athlete-local date + nearest distance, like import-manual-hr.ts) in
// parsed_json under source 'cardio_sheet'.
//
// The comments are personal, so they are NOT transcribed into this file: the
// rows live in a gitignored local JSON export (default
// data/cardio-sheet.local.json; override with AGON_CARDIO_SHEET_PATH or a path
// argument).
//
// Idempotent: a row whose (date, comment, distance) already exists as a
// cardio_sheet qualitative log is skipped, so re-running is a no-op.
//
//   pnpm tsx scripts/import-cardio-comments.ts [path]            DRY RUN
//   pnpm tsx scripts/import-cardio-comments.ts [path] --write    insert

const SOURCE = 'cardio_sheet';
const DEFAULT_PATH = 'data/cardio-sheet.local.json';
/** A match beyond this distance delta (km) is recorded as unmatched. */
const DIST_MATCH_TOLERANCE_KM = 1.0;
// The sheet is hand-dated, and a late-evening run can land on the next day's
// row (sheet 23/05 = a run starting 21:30 on 05-22). A ±1-day match is only
// accepted when the distance is near-exact, so it can't claim a different run.
const ADJACENT_DAY_TOLERANCE_KM = 0.1;

/** YYYY-MM-DD shifted by `days` (UTC arithmetic — dates only, no clock). */
function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const rowSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateCorrectedFrom: z.string().optional(),
  week: z.number().int().nullable().optional(),
  routine: z.string().nullable().optional(),
  routineKarvonen: z.string().nullable().optional(),
  distanceKm: z.number().positive(),
  time: z.string().nullable().optional(),
  avgHr: z.number().int().nullable(),
  tempC: z.number().nullable().optional(),
  humidityPct: z.number().nullable().optional(),
  comment: z.string().min(1),
});
const fileSchema = z.object({
  source: z.string(),
  capturedAt: z.string(),
  rows: z.array(rowSchema),
});
type SheetRow = z.infer<typeof rowSchema>;

interface RunRow {
  id: string;
  localDate: string;
  distanceKm: number;
}

async function loadRuns(dates: string[]): Promise<RunRow[]> {
  const { rows } = await query<{
    id: string;
    local_date: string;
    distance_km: string;
  }>(
    `SELECT id,
            COALESCE((started_at AT TIME ZONE 'Europe/Berlin')::date, date)::text AS local_date,
            distance_km
       FROM public.runs
      WHERE COALESCE((started_at AT TIME ZONE 'Europe/Berlin')::date, date)::text = ANY($1)`,
    [dates],
  );
  return rows.map((r) => ({
    id: r.id,
    localDate: r.local_date,
    distanceKm: Number(r.distance_km),
  }));
}

type RunMatch = RunRow & { deltaKm: number; dayOffset: number };

/**
 * Nearest-distance run per sheet row, each run claimed at most once. Same-day
 * matches are resolved for every row first, so an adjacent-day fallback can
 * never steal a run that belongs to its own day's row.
 */
function matchRuns(sheet: SheetRow[], runs: RunRow[]): (RunMatch | null)[] {
  const used = new Set<string>();
  const out: (RunMatch | null)[] = sheet.map(() => null);
  const pass = (offsets: number[], toleranceKm: number) => {
    sheet.forEach((row, i) => {
      if (out[i]) return;
      let best: RunMatch | null = null;
      for (const offset of offsets) {
        const day = shiftDate(row.date, offset);
        for (const r of runs) {
          if (r.localDate !== day || used.has(r.id)) continue;
          const deltaKm = Math.abs(r.distanceKm - row.distanceKm);
          if (deltaKm <= toleranceKm && (!best || deltaKm < best.deltaKm))
            best = { ...r, deltaKm, dayOffset: offset };
        }
      }
      if (best) {
        used.add(best.id);
        out[i] = best;
      }
    });
  };
  pass([0], DIST_MATCH_TOLERANCE_KM);
  pass([-1, 1], ADJACENT_DAY_TOLERANCE_KM);
  return out;
}

/** The existing cardio_sheet log for this row, if already imported. */
async function findImported(
  row: SheetRow,
): Promise<{ id: string; runId: string | null } | null> {
  const { rows } = await query<{ id: string; run_id: string | null }>(
    `SELECT id, parsed_json->>'runId' AS run_id
       FROM public.qualitative_logs
      WHERE parsed_json->>'source' = $1
        AND date = $2
        AND raw_transcript = $3
        AND (parsed_json->'sheet'->>'distanceKm')::numeric = $4
      LIMIT 1`,
    [SOURCE, row.date, row.comment, row.distanceKm],
  );
  return rows[0] ? { id: rows[0].id, runId: rows[0].run_id } : null;
}

/**
 * Link an already-imported row to a run that has appeared since (e.g. a later
 * Google Health backfill). Only fills a missing link — never re-points one.
 */
async function relink(logId: string, run: RunMatch): Promise<void> {
  await query(
    `UPDATE public.qualitative_logs
        SET parsed_json = parsed_json
              || jsonb_build_object('runId', $2::text, 'runDayOffset', $3::int)
      WHERE id = $1 AND parsed_json->>'runId' IS NULL`,
    [logId, run.id, run.dayOffset],
  );
}

async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const path =
    args.find((a) => !a.startsWith('--')) ??
    process.env.AGON_CARDIO_SHEET_PATH ??
    DEFAULT_PATH;
  logger.info('starting cardio-comment import', {
    job: 'cardio-comments',
    write,
    path,
  });

  const file = fileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const runs = await loadRuns([
    ...new Set(
      file.rows.flatMap((r) => [-1, 0, 1].map((d) => shiftDate(r.date, d))),
    ),
  ]);
  const matches = matchRuns(file.rows, runs);

  let inserted = 0;
  let skipped = 0;
  let unmatched = 0;
  let relinked = 0;
  const out: string[] = [
    '',
    `Cardio-sheet comments → qualitative_logs (${path}):`,
  ];
  for (let i = 0; i < file.rows.length; i++) {
    const row = file.rows[i]!;
    const run = matches[i];
    if (!run) unmatched++;
    const existing = await findImported(row);
    const canRelink = existing !== null && existing.runId === null && !!run;
    const action = canRelink
      ? write
        ? 'relinked to run'
        : 'would relink to run'
      : existing
        ? 'skip — already imported'
        : write
          ? 'inserted'
          : 'would insert';
    out.push(
      `  ${row.date}  ${row.distanceKm.toFixed(2).padStart(6)} km  run=${
        run
          ? `${run.id.slice(0, 8)} (Δ${run.deltaKm.toFixed(2)}${
              run.dayOffset
                ? `, ${run.dayOffset > 0 ? '+' : ''}${run.dayOffset}d`
                : ''
            })`
          : '— none —   '
      }  ${action}`,
    );
    if (existing) {
      if (canRelink) {
        relinked++;
        if (write) await relink(existing.id, run);
      } else {
        skipped++;
      }
      continue;
    }
    if (!write) continue;
    await insertQualitativeLog({
      date: row.date,
      sessionType: 'run',
      rawTranscript: row.comment,
      parsedJson: {
        source: SOURCE,
        sourceRef: file.source,
        capturedAt: file.capturedAt,
        runId: run?.id ?? null,
        runDayOffset: run?.dayOffset ?? null,
        sheet: {
          week: row.week ?? null,
          routine: row.routine ?? null,
          routineKarvonen: row.routineKarvonen ?? null,
          distanceKm: row.distanceKm,
          time: row.time ?? null,
          avgHr: row.avgHr,
          tempC: row.tempC ?? null,
          humidityPct: row.humidityPct ?? null,
          dateCorrectedFrom: row.dateCorrectedFrom ?? null,
        },
      },
    });
    inserted++;
  }
  out.push('');
  out.push(
    `Rows: ${file.rows.length}  ·  no matching run: ${unmatched}  ·  already imported: ${skipped}  ·  relinked: ${relinked}`,
  );
  out.push(
    write
      ? `WROTE ${inserted} qualitative_logs row(s).`
      : 'DRY RUN — no changes written. Re-run with --write to apply.',
  );
  console.log(out.join('\n'));
}

main()
  .catch((err) => {
    logger.error('cardio-comment import failed', {
      job: 'cardio-comments',
      err,
    });
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
