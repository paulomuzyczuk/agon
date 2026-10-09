import { spawnSync } from 'child_process';
import { readFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { loadEnv } from './loadEnv';
import {
  summarizeFreshness,
  type FreshnessArtifact,
} from '../lib/dataFreshness';
import { sendMessage } from '../services/telegram/api';
import { logger } from '../services/logger';

// The ingestion DEAD-MAN'S SWITCH (CLAUDE.md, Analytics Stack): run dbt's source
// freshness checks and TELL SOMEONE when a pipeline has stopped feeding the
// database.
//
// Built after a real outage — between 2026-08-04 and 2026-08-20 no run reached
// Postgres, the training-load curve quietly went wrong (TSB read +32.8 "deep
// taper" during a normal training block), and the gap was found by accident.
// dbt could already detect that; nothing was watching, which is the same as not
// detecting it.
//
//   pnpm data:freshness                 run checks, print, notify, exit non-zero on error
//   pnpm data:freshness --no-telegram   print only
//
// Exits 1 when any source is error-level OR the check itself could not run, so a
// systemd timer / CI job fails loudly. Thresholds live in
// analytics/models/staging/_sources.yml — one source of truth, not two.

const SOURCES_JSON = resolve(process.cwd(), 'analytics/target/sources.json');

/** Run `dbt source freshness`. dbt exits non-zero on error-level staleness, which
 *  is a RESULT, not a crash — so the exit code is ignored and the artifact read. */
function runDbtFreshness(): { ran: boolean; detail: string } {
  // Delete the previous artifact FIRST. dbt only writes sources.json when it
  // actually connects and checks, so a failed run leaves the last successful one
  // in place — and reading that reports a dead pipeline as healthy, which is the
  // one outcome this whole script exists to prevent. (Observed: a bad DBT_HOST
  // made dbt fail while the check cheerfully printed "All 6 sources fresh".)
  rmSync(SOURCES_JSON, { force: true });

  const res = spawnSync('bash', ['analytics/dbt.sh', 'source', 'freshness'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    timeout: 10 * 60 * 1000,
  });
  if (res.error) return { ran: false, detail: res.error.message };
  // A missing Docker image or an unreachable database prints nothing usable to
  // stdout; keep the tail of stderr so the alert can say WHY it couldn't check.
  const stderr = (res.stderr ?? '').trim().split('\n').slice(-3).join('\n');
  return { ran: true, detail: stderr };
}

function readArtifact(): FreshnessArtifact | null {
  try {
    const parsed = JSON.parse(readFileSync(SOURCES_JSON, 'utf-8')) as unknown;
    const results = (parsed as FreshnessArtifact).results;
    return Array.isArray(results) ? { results } : null;
  } catch {
    return null;
  }
}

async function notify(message: string): Promise<void> {
  const chatId = Number(process.env.TELEGRAM_OWNER_CHAT_ID);
  if (!chatId) {
    // Not a failure: the check still ran and still exits non-zero. Say so, so a
    // silent Telegram isn't mistaken for a healthy pipeline.
    // eslint-disable-next-line no-console
    console.log(
      '(TELEGRAM_OWNER_CHAT_ID not set — printed above, not sent to Telegram)',
    );
    return;
  }
  try {
    await sendMessage(chatId, message);
  } catch (err) {
    // Never let a notification failure mask the freshness verdict itself.
    logger.warn('freshness alert could not be sent', {
      job: 'data-freshness',
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function main(): Promise<void> {
  loadEnv();
  const withTelegram = !process.argv.includes('--no-telegram');

  const { ran, detail } = runDbtFreshness();
  const artifact = ran ? readArtifact() : null;

  if (!artifact) {
    const message =
      '🔴 Agon data freshness: the check itself could not run — ' +
      'the pipelines are UNVERIFIED, not healthy.' +
      (detail ? `\n${detail}` : '');
    // eslint-disable-next-line no-console
    console.error(`\n${message}\n`);
    if (withTelegram) await notify(message);
    logger.error('freshness check could not run', { job: 'data-freshness' });
    process.exitCode = 1;
    return;
  }

  const report = summarizeFreshness(artifact);
  // eslint-disable-next-line no-console
  console.log(
    `\n${report.message ?? `✅ All ${report.checked} source(s) fresh.`}\n`,
  );
  logger.info('freshness check complete', {
    job: 'data-freshness',
    checked: report.checked,
    stale: report.stale.length,
    failed: report.failed,
  });

  // Warnings are worth a message too: the point is to hear about drift BEFORE it
  // becomes a two-week hole.
  if (report.message && withTelegram) await notify(report.message);
  if (report.failed) process.exitCode = 1;
}

main().catch((err) => {
  logger.error('data:freshness failed', { job: 'data-freshness' }, err);
  process.exitCode = 1;
});
