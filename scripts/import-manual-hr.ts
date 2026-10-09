import { loadEnv } from './loadEnv';
import { query, closeDbPool } from '../services/db';
import { logger } from '../services/logger';

// Import the athlete's MANUAL average-HR estimates for the June 2026 runs that
// were recorded WITHOUT a chest strap (the Polar/Garmin HR monitor was failing
// that month). Those runs came in via Google Health with avg_hr NULL and no HR
// stream, so every June run scored 0 Relative Effort (Banister TRIMP) and
// craters CTL/ATL/TSB — June (the highest-volume month, ~179 km) reads as zero
// training load. This is the FALLBACK path (Strava had no HR for these runs
// either — same Fitbit-Air/phone source, no strap): fill avg_hr so the runs get
// an average-method TRIMP score, which `run_relative_effort.method='average'`
// already labels as lower-fidelity.
//
// Provenance: transcribed from the athlete's tracking spreadsheet
//   "Event Logging" › tab "Cardio"
//   https://docs.google.com/spreadsheets/d/11zVom5_IgrHCs1LAMoyjzoZYv5UgF1yji_t_yNB9TrE/
//   captured 2026-08-08. HR values there are the athlete's own estimates for the
//   strap-less runs (the sheet notes "Average HR is estimated"). Three runs have
//   no estimate at all (N/A) — they are LEFT NULL here, never fabricated, so they
//   stay unscored (labeled, not zero).
//
// A data update, not a schema change (no migration). Idempotent + COALESCE:
//   - only fills runs.avg_hr where it is currently NULL (never clobbers a real
//     chest-strap average), so re-running is a no-op once applied;
//   - stamps a general_notes provenance marker (only on rows it fills) so an
//     ESTIMATED average stays distinguishable from a measured-but-streamless one
//     (which method='average' alone cannot tell apart).
//
//   pnpm tsx scripts/import-manual-hr.ts            DRY RUN — print the diff, no writes
//   pnpm tsx scripts/import-manual-hr.ts --write    apply the COALESCE fills

/** One manual estimate row, keyed to a run by (local date, distance). */
interface ManualHr {
  /** Athlete-local calendar date of the run (Europe/Berlin), YYYY-MM-DD. */
  localDate: string;
  /** Distance in km as recorded in the sheet — disambiguates 2 runs on a day. */
  distanceKm: number;
  /** Estimated average HR (bpm), or null when the sheet has no value (N/A). */
  avgHr: number | null;
}

// Transcribed verbatim from the "Cardio" tab (June 2026). avgHr null = sheet N/A.
const MANUAL_HR: ManualHr[] = [
  { localDate: '2026-06-02', distanceKm: 6.14, avgHr: 170 },
  { localDate: '2026-06-03', distanceKm: 8.0, avgHr: 145 },
  { localDate: '2026-06-05', distanceKm: 17.0, avgHr: null }, // N/A — no HR data
  { localDate: '2026-06-07', distanceKm: 11.27, avgHr: null }, // N/A — no HR data
  { localDate: '2026-06-07', distanceKm: 8.46, avgHr: null }, // N/A — no HR data
  { localDate: '2026-06-09', distanceKm: 8.82, avgHr: 160 },
  { localDate: '2026-06-11', distanceKm: 8.03, avgHr: 140 },
  { localDate: '2026-06-12', distanceKm: 12.76, avgHr: 145 },
  { localDate: '2026-06-14', distanceKm: 12.48, avgHr: 150 },
  { localDate: '2026-06-16', distanceKm: 9.0, avgHr: 165 },
  { localDate: '2026-06-18', distanceKm: 10.11, avgHr: 140 },
  { localDate: '2026-06-20', distanceKm: 21.1, avgHr: 145 },
  { localDate: '2026-06-21', distanceKm: 8.22, avgHr: 150 },
  { localDate: '2026-06-24', distanceKm: 9.2, avgHr: 175 },
  { localDate: '2026-06-25', distanceKm: 2.17, avgHr: 155 },
  { localDate: '2026-06-26', distanceKm: 12.9, avgHr: 155 },
  { localDate: '2026-06-27', distanceKm: 4.7, avgHr: 155 },
  { localDate: '2026-06-28', distanceKm: 9.03, avgHr: 150 },
];

const PROVENANCE_NOTE =
  'avg_hr estimated by athlete (chest-strap failure); imported from Cardio sheet 2026-06';

/** A run beyond which a date+distance match is too loose to trust (km). */
const DIST_MATCH_TOLERANCE_KM = 1.0;

interface RunRow {
  id: string;
  localDate: string;
  distanceKm: number;
  avgHr: number | null;
}

async function loadCandidateRuns(dates: string[]): Promise<RunRow[]> {
  const { rows } = await query<{
    id: string;
    local_date: string;
    distance_km: string;
    avg_hr: number | null;
  }>(
    `SELECT id,
            (started_at AT TIME ZONE 'Europe/Berlin')::date::text AS local_date,
            distance_km,
            avg_hr
       FROM public.runs
      WHERE started_at IS NOT NULL
        AND (started_at AT TIME ZONE 'Europe/Berlin')::date::text = ANY($1)`,
    [dates],
  );
  return rows.map((r) => ({
    id: r.id,
    localDate: r.local_date,
    distanceKm: Number(r.distance_km),
    avgHr: r.avg_hr,
  }));
}

async function applyFill(id: string, avgHr: number): Promise<number> {
  // The `AND avg_hr IS NULL` guard makes this COALESCE-safe + idempotent: a run
  // that already has a (measured) average is never overwritten, and re-runs are
  // no-ops. avg_hr_estimated = true is the first-class provenance flag (a measured
  // average keeps the default false); general_notes carries the human-readable why.
  const { rowCount } = await query(
    `UPDATE public.runs
        SET avg_hr = $2,
            avg_hr_estimated = true,
            general_notes = COALESCE(general_notes, $3),
            updated_at = now()
      WHERE id = $1 AND avg_hr IS NULL`,
    [id, avgHr, PROVENANCE_NOTE],
  );
  return rowCount ?? 0;
}

interface Plan {
  entry: ManualHr;
  run: RunRow | null;
  distDeltaKm: number | null;
}

function planFills(runs: RunRow[]): Plan[] {
  const byDate = new Map<string, RunRow[]>();
  for (const r of runs) {
    const arr = byDate.get(r.localDate) ?? [];
    arr.push(r);
    byDate.set(r.localDate, arr);
  }
  const usedRunIds = new Set<string>();

  return MANUAL_HR.map((entry) => {
    const sameDay = (byDate.get(entry.localDate) ?? []).filter(
      (r) => !usedRunIds.has(r.id),
    );
    // Nearest distance among that day's not-yet-claimed runs.
    let best: RunRow | null = null;
    let bestDelta = Infinity;
    for (const r of sameDay) {
      const delta = Math.abs(r.distanceKm - entry.distanceKm);
      if (delta < bestDelta) {
        best = r;
        bestDelta = delta;
      }
    }
    if (best) usedRunIds.add(best.id);
    return {
      entry,
      run: best,
      distDeltaKm: best ? bestDelta : null,
    };
  });
}

async function main(): Promise<void> {
  loadEnv();
  const write = process.argv.slice(2).includes('--write');
  logger.info('starting manual-HR import', { job: 'manual-hr', write });

  const dates = [...new Set(MANUAL_HR.map((m) => m.localDate))];
  const runs = await loadCandidateRuns(dates);
  const plans = planFills(runs);

  const out: string[] = [];
  out.push('');
  out.push(
    'Manual June-2026 avg-HR import (COALESCE — fills only NULL avg_hr):',
  );
  out.push(
    '  local date   sheet_km  matched_km  Δkm    existing  proposed  action',
  );
  let willFill = 0;
  let alreadySet = 0;
  let noEstimate = 0;
  let unmatched = 0;
  let suspect = 0;

  for (const p of plans) {
    const { entry, run, distDeltaKm } = p;
    const sheetKm = entry.distanceKm.toFixed(2).padStart(7);
    let matchedKm = '   —  ';
    let delta = '  — ';
    let existing = '   — ';
    let proposed = '   — ';
    let action: string;

    if (!run) {
      action = '⚠ NO MATCHING RUN';
      unmatched++;
    } else {
      matchedKm = run.distanceKm.toFixed(2).padStart(8);
      delta = (distDeltaKm ?? 0).toFixed(2).padStart(4);
      existing = run.avgHr == null ? ' NULL' : String(run.avgHr).padStart(5);
      const tooFar = (distDeltaKm ?? 0) > DIST_MATCH_TOLERANCE_KM;
      if (entry.avgHr == null) {
        action = 'skip — sheet N/A (leave NULL, unscored)';
        noEstimate++;
      } else if (run.avgHr != null) {
        proposed = String(entry.avgHr).padStart(5);
        action = 'skip — already has avg_hr (kept)';
        alreadySet++;
      } else if (tooFar) {
        proposed = String(entry.avgHr).padStart(5);
        action = `⚠ SKIP — distance Δ ${delta}km > ${DIST_MATCH_TOLERANCE_KM}km`;
        suspect++;
      } else {
        proposed = String(entry.avgHr).padStart(5);
        action = write ? 'FILL' : 'would fill';
        willFill++;
      }
    }
    out.push(
      `  ${entry.localDate}  ${sheetKm}  ${matchedKm}  ${delta}  ${existing}  ${proposed}  ${action}`,
    );
  }

  out.push('');
  out.push(`Matched estimates to fill:   ${willFill}`);
  out.push(
    `Left NULL (sheet N/A):       ${noEstimate}  (stay unscored — never fabricated)`,
  );
  if (alreadySet) out.push(`Skipped (already had avg_hr): ${alreadySet}`);
  if (suspect)
    out.push(`Skipped (distance mismatch): ${suspect}  (review manually)`);
  if (unmatched)
    out.push(`Manual rows with no DB run:  ${unmatched}  (review manually)`);
  out.push('');

  if (!write) {
    out.push('DRY RUN — no changes written. Re-run with --write to apply.');
    // eslint-disable-next-line no-console
    console.log(out.join('\n') + '\n');
    return;
  }

  let filled = 0;
  for (const p of plans) {
    if (!p.run || p.entry.avgHr == null) continue;
    if (p.run.avgHr != null) continue;
    if ((p.distDeltaKm ?? 0) > DIST_MATCH_TOLERANCE_KM) continue;
    filled += await applyFill(p.run.id, p.entry.avgHr);
  }

  out.push(`WROTE avg_hr to ${filled} run(s).`);
  out.push(
    'Next: `pnpm re:backfill` (dry-run) → `--write`, then `pnpm tl:backfill --write`, then `pnpm dbt build`.',
  );
  out.push('');
  // eslint-disable-next-line no-console
  console.log(out.join('\n') + '\n');
}

main()
  .catch((err) => {
    logger.error('manual-HR import failed', { job: 'manual-hr' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
