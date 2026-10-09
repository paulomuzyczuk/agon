import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import { getAthleteProfile } from '../lib/athleteProfile';
import { fitPaceHrModel } from '../lib/relativeEffort';
import {
  loadScorableRuns,
  loadHrStreams,
  loadPaceHrPairs,
  scoreRun,
  upsertRunRelativeEffort,
  type HrStreamRow,
  type RelativeEffortRow,
} from '../services/relativeEffort';

// Backfill Relative Effort (per-activity Banister TRIMP, Premium-Parity #7) for
// every run with heart-rate data. Prefers the richest HR stream (most non-null
// samples) integrated sample-by-sample; falls back to a run's average HR when no
// usable stream exists. Pure math is in lib/relativeEffort.ts; the per-run tier
// choice is services/relativeEffort.ts scoreRun (shared with the single-run
// recompute after a hand correction, MZY-253).
//
//   pnpm re:backfill            DRY RUN — compute + print, no writes
//   pnpm re:backfill --write    upsert into public.run_relative_effort
//
// Idempotent (run_id PK): re-running recomputes + overwrites each score.

const profile = getAthleteProfile();
const anchors = { hrRest: profile.hrRest, hrMax: profile.hrMax };

function parseArgs(argv: string[]): { write: boolean } {
  return { write: argv.includes('--write') };
}

async function main(): Promise<void> {
  loadEnv();
  const { write } = parseArgs(process.argv.slice(2));
  logger.info('starting relative-effort backfill', {
    job: 'relative-effort',
    write,
    anchors,
  });

  const runs = await loadScorableRuns();
  const streamsByRun = new Map<string, HrStreamRow[]>();
  for (const s of await loadHrStreams()) {
    const arr = streamsByRun.get(s.runId) ?? [];
    arr.push(s);
    streamsByRun.set(s.runId, arr);
  }

  // Fit the athlete's own pace→HR model for the last-resort surrogate (runs with
  // no stream and no average HR — not even a manual estimate). Null when there
  // aren't enough measured pairs; those runs then stay unscored (not fabricated).
  const paceModel = fitPaceHrModel(await loadPaceHrPairs());

  const scored: Array<
    RelativeEffortRow & { date: string; distanceKm: number }
  > = [];
  let skipped = 0;
  for (const run of runs) {
    const row = scoreRun(
      run,
      streamsByRun.get(run.runId) ?? [],
      anchors,
      paceModel,
    );
    if (!row) {
      skipped++;
      continue;
    }
    scored.push({ ...row, date: run.date, distanceKm: run.distanceKm });
    if (write) await upsertRunRelativeEffort(row);
  }

  const out: string[] = [];
  const nStream = scored.filter((s) => s.method === 'stream').length;
  const nAvg = scored.filter((s) => s.method === 'average').length;
  const nPace = scored.filter((s) => s.method === 'estimated_pace').length;
  out.push('');
  out.push(`Scorable runs:       ${runs.length}`);
  out.push(
    `  scored:            ${scored.length}  (${nStream} stream, ${nAvg} avg-HR, ${nPace} pace-estimated)`,
  );
  out.push(`  skipped (no data): ${skipped}`);
  out.push(
    `HR anchors:          rest ${anchors.hrRest} / max ${anchors.hrMax} bpm`,
  );
  out.push(
    paceModel
      ? `Pace→HR model:       HR ≈ ${paceModel.a.toFixed(1)} + ${paceModel.b.toFixed(1)}·(m/s)` +
          `  (n=${paceModel.n}, R²=${paceModel.r2.toFixed(3)}) — used for ${nPace} HR-less run(s)`
      : `Pace→HR model:       not fitted (too few measured pairs) — HR-less runs left unscored`,
  );
  out.push('');
  out.push('Relative Effort per run (most recent 15):');
  out.push('  date        dist    RE     method          src');
  for (const s of scored.slice(-15).reverse()) {
    out.push(
      `  ${s.date}  ${s.distanceKm.toFixed(1).padStart(5)}km  ${String(s.score).padStart(6)}  ` +
        `${s.method.padEnd(14)} ${s.streamSource ?? '-'}`,
    );
  }
  out.push('');
  out.push(
    write
      ? `WROTE ${scored.length} relative-effort row(s) to public.run_relative_effort.`
      : 'DRY RUN — no changes written. Re-run with --write to persist.',
  );
  out.push(
    'Next: build the fct_relative_effort dbt mart (feeds fct_training_load_daily).',
  );
  out.push('');
  // eslint-disable-next-line no-console
  console.log(out.join('\n') + '\n');
}

main()
  .catch((err) => {
    logger.error(
      'relative-effort backfill failed',
      { job: 'relative-effort' },
      err,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
