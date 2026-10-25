import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadEnv } from './loadEnv';
import {
  dbTarget,
  docker,
  exactRowCounts,
  psql,
  takeVerifiedDump,
} from './backupShared';
import { dumpFileName } from '../lib/backupRotation';

// Restore drill (MZY-209): proves the backup path actually restores. A backup
// that has never been restored is a hope, not a backup.
//
//   pnpm db:restore-drill
//
// 1. Exact row counts of the live DB (A).
// 2. A fresh dump via the same takeVerifiedDump() the scheduled backup uses.
// 3. Exact row counts of the live DB again (B).
// 4. Restore the dump into a scratch database (`agon_restore_test`) in the
//    same container, and count its rows (R).
// 5. Per table: PASS if R = A = B. If A != B the table was written to while
//    the dump ran (the bot/timers are live), so that table is INCONCLUSIVE,
//    not failed. FAIL if A = B but R differs.
// 6. Drop the scratch DB.
//
// It NEVER writes to the live database: the only DDL is CREATE/DROP of the
// scratch database, whose name is fixed and refused if it equals the live one.

const SCRATCH_DB = 'agon_restore_test';

async function main(): Promise<void> {
  loadEnv();
  const t = dbTarget();
  if (t.database === SCRATCH_DB)
    throw new Error('refusing: live DB is the scratch DB name');

  const workDir = mkdtempSync(join(tmpdir(), 'agon-restore-drill-'));
  const dump = join(workDir, dumpFileName(new Date()));
  try {
    const before = await exactRowCounts(t, t.database);
    await takeVerifiedDump(t, dump);
    const after = await exactRowCounts(t, t.database);

    await psql(t, 'postgres', `DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await psql(t, 'postgres', `CREATE DATABASE ${SCRATCH_DB}`);
    // --exit-on-error: any restore error fails the drill instead of being
    // skipped past with a warning.
    await docker(
      [
        'exec',
        '-i',
        t.container,
        'pg_restore',
        '-U',
        t.user,
        '-d',
        SCRATCH_DB,
        '--exit-on-error',
      ],
      { stdinFile: dump },
    );
    const restored = await exactRowCounts(t, SCRATCH_DB);

    let failed = 0;
    let inconclusive = 0;
    let rows = 0;
    for (const [table, a] of before) {
      const b = after.get(table);
      const r = restored.get(table);
      if (a !== b) {
        inconclusive++;
        // eslint-disable-next-line no-console
        console.log(
          `INCONCLUSIVE ${table}: live changed during dump (${a} -> ${b}), restored ${r}`,
        );
      } else if (r !== a) {
        failed++;
        // eslint-disable-next-line no-console
        console.log(`FAIL ${table}: live ${a}, restored ${r ?? 'missing'}`);
      } else {
        rows += a;
      }
    }
    for (const table of restored.keys()) {
      if (!before.has(table)) {
        failed++;
        // eslint-disable-next-line no-console
        console.log(`FAIL ${table}: in restore but not in live DB`);
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `restore drill: ${before.size} tables, ${rows} rows matched, ` +
        `${failed} failed, ${inconclusive} inconclusive`,
    );
    if (failed > 0) process.exitCode = 1;
  } finally {
    await psql(t, 'postgres', `DROP DATABASE IF EXISTS ${SCRATCH_DB}`).catch(
      () => undefined,
    );
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(
    `restore drill FAILED: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
