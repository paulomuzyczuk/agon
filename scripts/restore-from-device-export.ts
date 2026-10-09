import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadEnv } from './loadEnv';
import { closeDbPool, query } from '../services/db';
import {
  exportToMutations,
  parseDeviceExport,
  restoreDeviceExport,
  RESTORE_ORDER,
} from '../services/sync/restore';

// Rebuild the athlete-authored tables from a PWA device export (MZY-207).
// Procedure + when to use it: docs/self-hosting/backups.md ("Recovering from a
// device"). Safe to run against production: it only merges (older stamps lose
// to newer server data, nothing is deleted), and a second run is a no-op.
//
//   pnpm db:restore-device-export <export.json>          dry run: what's missing
//   pnpm db:restore-device-export <export.json> --apply  write it

async function main(): Promise<void> {
  loadEnv();
  const [file, flag] = process.argv.slice(2);
  if (!file)
    throw new Error(
      'usage: pnpm db:restore-device-export <export.json> [--apply]',
    );
  const exp = parseDeviceExport(
    JSON.parse(readFileSync(resolve(file), 'utf-8')),
  );

  // eslint-disable-next-line no-console
  console.log(
    `export from ${exp.exportedAt}: ${exportToMutations(exp).length} field values`,
  );
  for (const t of RESTORE_ORDER) {
    const ids = (exp.tables[t] ?? []).map((r) => String(r.id));
    if (ids.length === 0) continue;
    const { rows } = await query<{ n: string }>(
      `SELECT count(*) AS n FROM public."${t}" WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    // eslint-disable-next-line no-console
    console.log(
      `  ${t}: ${ids.length} rows in export, ${ids.length - Number(rows[0]!.n)} missing on server`,
    );
  }

  if (flag !== '--apply') {
    // eslint-disable-next-line no-console
    console.log(
      'dry run — take a backup (pnpm db:backup), then re-run with --apply',
    );
    return;
  }
  const summary = await restoreDeviceExport(exp);
  // eslint-disable-next-line no-console
  console.log(
    `applied ${summary.applied}, already current ${summary.skipped}, rejected ${summary.rejected.length}`,
  );
  for (const r of summary.rejected.slice(0, 20)) {
    // eslint-disable-next-line no-console
    console.log(
      `  rejected ${r.mutation.table}.${r.mutation.field} (${r.mutation.id}): ${r.error}`,
    );
  }
  if (summary.rejected.length > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void closeDbPool());
