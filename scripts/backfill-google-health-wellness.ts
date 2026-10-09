import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { backfillGoogleHealthWellness } from '../services/googleHealth/wellness';
import { logger } from '../services/logger';

// Google Health wellness backfill (Workstream C — Fitbit Web API → Google Health,
// before the Fitbit API sunsets Sept 2026). Pulls all-day activity + resting HR
// (→ daily_activity), sleep (→ sleep_sessions), HRV (→ hrv_daily), and weight/
// body-fat (→ body_metrics, MZY-216) onto the
// same Google Health client the run adapter uses. Run HR is NOT here — it already
// migrated as part of `gh:sync` (heartRate.ts attaches Fitbit-wrist HR per run).
//
// This is the wellness counterpart to `gh:sync` (which owns the per-run watermark
// path). It mirrors the Fitbit backfill's date-range + `--only` shape:
//
//   pnpm gh:wellness --since=2026-07-01                 all passes
//   pnpm gh:wellness --since=2026-07-01 --until=2026-07-31
//   pnpm gh:wellness --since=2026-07-01 --only=sleep,hrv
//   pnpm gh:wellness --since=2026-07-01 --only=activity
//   pnpm gh:wellness --since=2025-01-01 --only=body       weight history
//
// Idempotent + rate-limit-aware; safe to re-run. Needs Google OAuth tokens with
// the sleep scope — run `pnpm gh:auth` once (re-consent) to authorize.

const PASSES = ['activity', 'sleep', 'hrv', 'body'] as const;
type Pass = (typeof PASSES)[number];

function selectedPasses(argv: string[]): Record<Pass, boolean> {
  const only = argv.find((a) => a.startsWith('--only='));
  if (!only) return { activity: true, sleep: true, hrv: true, body: true };
  const set = new Set(
    only
      .slice('--only='.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const p of set) {
    if (!PASSES.includes(p as Pass)) {
      throw new Error(
        `gh:wellness: unknown pass '${p}' in --only (valid: ${PASSES.join(', ')})`,
      );
    }
  }
  return {
    activity: set.has('activity'),
    sleep: set.has('sleep'),
    hrv: set.has('hrv'),
    body: set.has('body'),
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateArg(argv: string[], flag: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${flag}=`));
  if (!hit) return undefined;
  const value = hit.slice(flag.length + 1);
  if (!DATE_RE.test(value)) {
    throw new Error(`gh:wellness: ${flag} must be YYYY-MM-DD (got '${value}')`);
  }
  return value;
}

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const since = dateArg(argv, '--since');
  if (!since) {
    throw new Error(
      'gh:wellness: --since=YYYY-MM-DD is required (e.g. --since=2026-07-01)',
    );
  }
  const until = dateArg(argv, '--until');
  const passes = selectedPasses(argv);

  logger.info('starting google-health wellness backfill', {
    job: 'google-health-wellness',
    since,
    until: until ?? null,
    ...passes,
  });

  const summary = await backfillGoogleHealthWellness({
    since,
    until,
    activity: passes.activity,
    sleep: passes.sleep,
    hrv: passes.hrv,
    body: passes.body,
  });

  // eslint-disable-next-line no-console
  console.log(
    `\nGoogle Health wellness: ${summary.activityDaysUpserted} activity days, ` +
      `${summary.sleepUpserted} sleep sessions, ${summary.hrvUpserted} HRV days, ` +
      `${summary.bodyUpserted} body metrics` +
      `${summary.rateLimited ? ' (STOPPED on rate limit — re-run to resume)' : ''}.\n`,
  );
}

main()
  .catch((err) => {
    logger.error(
      'google-health wellness backfill failed',
      { job: 'google-health-wellness' },
      err,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
