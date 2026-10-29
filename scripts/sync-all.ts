import { spawn } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { dirname, resolve } from 'path';
import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { sendMessage } from '../services/telegram/api';
import { logger } from '../services/logger';
import { athleteLocalParts } from '../lib/time';
import { getAthleteProfile } from '../lib/athleteProfile';
import {
  syncSteps,
  runAll,
  decideAlert,
  formatAlert,
  lastLines,
  type AlertState,
  type SyncStep,
} from '../lib/syncAll';

// Pull every live source in one go: Google Health runs, rides and wellness, then
// Strava runs and rides. Meant for a timer (deploy/user/agon-sync.timer, once a
// day); also fine by hand.
//
//   pnpm sync:all
//
// A failing step never stops the others. The command exits 1 if any step failed,
// so the scheduler shows the unit as failed, and the owner gets ONE Telegram
// message per new failure (again after a day if it persists), not one per run.
// Plain `gcal:sync` is deliberately not here: it overwrites hand edits in Google
// Calendar. The Monday job (gcal:weekly-reconcile) owns the calendar.

const STATE_FILE = resolve(
  process.env.AGON_SYNC_STATE || 'data/sync-all.state.json',
);

function readState(): AlertState | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as AlertState;
  } catch {
    return null; // first run, or unreadable: treat as "nothing reported yet"
  }
}

function writeState(state: AlertState | null): void {
  if (state === null) {
    rmSync(STATE_FILE, { force: true });
    return;
  }
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

function runStep(step: SyncStep): Promise<{ code: number; tail: string }> {
  return new Promise((resolveStep, reject) => {
    const child = spawn('pnpm', step.args, { env: process.env });
    let out = '';
    const keep = (b: Buffer) => {
      process.stdout.write(b);
      out = (out + b.toString()).slice(-4000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', reject);
    child.on('close', (code) =>
      resolveStep({ code: code ?? -1, tail: lastLines(out) }),
    );
  });
}

async function notifyOwner(text: string): Promise<void> {
  const chatId = Number(process.env.TELEGRAM_OWNER_CHAT_ID);
  if (!chatId) return;
  try {
    await sendMessage(chatId, text);
  } catch (err) {
    logger.warn('sync:all could not send the alert', {
      job: 'sync-all',
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function main(): Promise<void> {
  loadEnv();
  const today = athleteLocalParts(
    new Date().toISOString(),
    getAthleteProfile().timeZone,
  ).date;
  const results = await runAll(syncSteps(today), runStep);
  for (const r of results) {
    logger.info('sync step finished', {
      job: 'sync-all',
      step: r.name,
      ok: r.ok,
      code: r.code,
    });
  }
  const { alert, next } = decideAlert(results, readState(), Date.now());
  writeState(next);
  if (alert) await notifyOwner(formatAlert(results));
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main()
  .catch((err) => {
    logger.error('sync:all failed', { job: 'sync-all' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
