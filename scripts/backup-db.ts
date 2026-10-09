import { mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { loadEnv } from './loadEnv';
import { dbTarget, takeVerifiedDump } from './backupShared';
import { dumpFileName, selectDumpsToDelete } from '../lib/backupRotation';
import { sendMessage } from '../services/telegram/api';

// Scheduled Postgres backup (MZY-209). Until this existed, all athlete data
// lived only in the `agon_agon_pgdata` Docker volume — and on 2026-09-08 that
// volume was deleted with no backup (MZY-113).
//
//   pnpm db:backup          dump, verify, rotate; exit non-zero on any failure
//
// Env (all optional except DATABASE_URL):
//   AGON_BACKUP_DIR          where dumps go (default ./backups, gitignored)
//   AGON_BACKUP_KEEP_DAILY   newest N dumps always kept (default 14)
//   AGON_BACKUP_KEEP_WEEKLY  newest dump of each of the newest N ISO weeks (default 8)
//   AGON_DB_CONTAINER        Postgres container (default agon-db-1)
//
// Failure is messaged to Telegram when TELEGRAM_OWNER_CHAT_ID is set: a
// backup job that fails silently is how you discover, on the day you need
// it, that you have no backup. Success is silent. Restore procedure and the
// restore drill: docs/self-hosting/backups.md.

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : fallback;
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`${name} must be a positive integer`);
  return n;
}

async function notifyFailure(message: string): Promise<void> {
  const chatId = Number(process.env.TELEGRAM_OWNER_CHAT_ID);
  if (!chatId) return;
  try {
    await sendMessage(chatId, message);
  } catch {
    // The non-zero exit (and the scheduler's log) still records the failure.
  }
}

async function main(): Promise<void> {
  loadEnv();
  const dir = resolve(process.env.AGON_BACKUP_DIR || 'backups');
  const policy = {
    keepDaily: intEnv('AGON_BACKUP_KEEP_DAILY', 14),
    keepWeekly: intEnv('AGON_BACKUP_KEEP_WEEKLY', 8),
  };
  mkdirSync(dir, { recursive: true });

  const file = join(dir, dumpFileName(new Date()));
  const tables = await takeVerifiedDump(dbTarget(), file);
  const mb = (statSync(file).size / 1024 / 1024).toFixed(1);
  // eslint-disable-next-line no-console
  console.log(`backup ok: ${file} (${mb} MB, ${tables} tables with data)`);

  // Rotate only after a verified dump exists — a failing dump must never
  // be the reason older good backups get pruned.
  for (const name of selectDumpsToDelete(readdirSync(dir), policy)) {
    rmSync(join(dir, name));
    // eslint-disable-next-line no-console
    console.log(`rotated out: ${name}`);
  }
}

main().catch(async (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`backup FAILED: ${msg}`);
  await notifyFailure(`⚠️ Agon DB backup failed: ${msg.slice(0, 500)}`);
  process.exit(1);
});
