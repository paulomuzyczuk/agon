import { loadEnv } from './loadEnv';
import { query, closeDbPool } from '../services/db';
import { expandProgram } from '../lib/training/trainingProgram';
import { upsertAdjustment } from '../services/sessionAdjustments';
import { logger } from '../services/logger';

// One-time repair: lift every hand-made deviation out of planned_sessions and
// into session_adjustments, then restore the program rows to what
// docs/training-program.local.md actually says.
//
// Before the overlay existed, the only way to make the calendar match reality was
// to overwrite the plan in place — re-dating rows until plan_key disagreed with
// date, rewriting the heat week's descriptions and distances. Those edits are
// real work and must be PRESERVED, not discarded; they just belong in the other
// layer. Until they move, `pnpm seed:planned` silently reverts all of them.
//
//   pnpm plan:repair-drift            DRY RUN (no writes)
//   pnpm plan:repair-drift --write

interface Row {
  id: string;
  plan_key: string;
  date: string;
  description: string | null;
  target_distance_km: string | null;
  target_hr_cap: number | null;
  target_session_type: string | null;
}

const num = (v: string | null): number | null =>
  v === null ? null : Number(v);

async function main(): Promise<void> {
  loadEnv();
  const write = process.argv.includes('--write');

  // The program as authored — the values every plan row should hold.
  const specs = new Map(expandProgram().map((s) => [s.planKey, s]));

  const { rows } = await query<Row>(
    `SELECT id, plan_key, to_char(date,'YYYY-MM-DD') AS date, description,
            target_distance_km, target_hr_cap, target_session_type
       FROM public.planned_sessions
      WHERE plan_key IS NOT NULL
      ORDER BY date`,
  );

  let repaired = 0;
  for (const r of rows) {
    const spec = specs.get(r.plan_key);
    // Ad-hoc sessions (plan_key 'adhoc-run:<date>') have no program twin: they
    // ARE reality, with nothing to deviate from. Leave them alone.
    if (!spec) continue;

    const current = {
      date: r.date,
      description: r.description ?? '',
      targetDistanceKm: num(r.target_distance_km),
      targetHrCap: r.target_hr_cap,
      targetSessionType: r.target_session_type,
    };
    // Only fields that actually differ become overrides — an adjustment should
    // say what changed, not restate the whole session.
    const patch: Record<string, unknown> = {};
    if (current.date !== spec.dateISO) patch.date = current.date;
    if (current.description !== spec.description) {
      patch.description = current.description;
    }
    if (current.targetDistanceKm !== spec.targetDistanceKm) {
      patch.targetDistanceKm = current.targetDistanceKm;
    }
    if (current.targetHrCap !== spec.targetHrCap) {
      patch.targetHrCap = current.targetHrCap;
    }
    if (current.targetSessionType !== spec.targetSessionType) {
      patch.targetSessionType = current.targetSessionType;
    }
    if (Object.keys(patch).length === 0) continue;

    repaired++;
    // eslint-disable-next-line no-console
    console.log(
      `\n${r.plan_key}  (${spec.dateISO} → ${current.date})\n` +
        Object.entries(patch)
          .map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`)
          .join('\n'),
    );
    if (!write) continue;

    patch.note = 'adapted before the plan/reality split';
    await upsertAdjustment(r.id, patch, 'manual');
    // Restore the program row. Safe now: the deviation lives in the overlay.
    await query(
      `UPDATE public.planned_sessions
          SET date = $2::date, description = $3, target_distance_km = $4,
              target_hr_cap = $5, target_session_type = $6,
              block = $7, week = $8
        WHERE id = $1`,
      [
        r.id,
        spec.dateISO,
        spec.description,
        spec.targetDistanceKm,
        spec.targetHrCap,
        spec.targetSessionType,
        spec.block,
        spec.week,
      ],
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `\n${write ? 'Repaired' : 'Would repair'} ${repaired} drifted session(s) of ${rows.length}.` +
      (write ? '\n' : '\n(dry run — pass --write to apply)\n'),
  );
  logger.info('plan drift repair', { job: 'plan-drift', repaired, write });
}

main()
  .catch((err) => {
    logger.error('plan:repair-drift failed', { job: 'plan-drift' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
