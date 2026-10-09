import { formatHlc } from '@/lib/sync/hlc';
import { SYNC_TABLES, type SyncTableName } from '@/lib/sync/schema';
import type { FieldStamp } from '@/lib/sync/mergeField';
import {
  applyMutations,
  type FieldMutation,
  type MutationResult,
} from './apply';

// Rebuild Postgres's athlete-authored tables from a device export (MZY-207).
// Every PWA device holds the full replica (lib/sync/replica.ts) and can
// download it ("Export" in the sync bar). If the server loses the data again
// (the 2026-09-08 volume deletion, MZY-113), this replays that export through
// the ordinary merge path:
//
//   - every field is written with its ORIGINAL stamp from field_hlc, so the
//     merge treats the export as exactly what it is — an older copy. Rows the
//     server lost come back; anything the server has that is newer wins; a
//     second run changes nothing. Nothing is ever deleted by a restore.
//   - tables go parents-first so every FK target exists before its children.
//
// A row that never synced (written offline, exported before delivery) has no
// stamps: its fields get one at the row's created_at, or the export time,
// from node 'export'.

export const RESTORE_ORDER: SyncTableName[] = [
  'meal_logs',
  'meal_log_items',
  'lab_panels',
  'lab_panel_results',
  'injuries',
  'injury_updates',
  'medications',
  'medication_logs',
  'medical_visits',
  'vaccinations',
  'routines',
  'routine_steps',
  'routine_logs',
  'health_conditions',
  'session_adjustments',
];

export interface DeviceExport {
  format: 'agon-replica-export';
  version: 1;
  exportedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export function parseDeviceExport(json: unknown): DeviceExport {
  const e = json as Partial<DeviceExport>;
  if (
    e?.format !== 'agon-replica-export' ||
    e.version !== 1 ||
    typeof e.tables !== 'object'
  ) {
    throw new Error(
      'not an Agon device export (format agon-replica-export, version 1)',
    );
  }
  return e as DeviceExport;
}

function fallbackStamp(
  row: Record<string, unknown>,
  exportedAt: string,
): FieldStamp {
  const ms = Date.parse(String(row.created_at ?? exportedAt));
  return {
    hlc: formatHlc({
      wall: Number.isNaN(ms) ? Date.parse(exportedAt) : ms,
      counter: 0,
      node: 'export',
    }),
    origin: 'human',
  };
}

export function exportToMutations(exp: DeviceExport): FieldMutation[] {
  const out: FieldMutation[] = [];
  for (const table of RESTORE_ORDER) {
    const fields = Object.keys(SYNC_TABLES[table].fields);
    for (const row of exp.tables[table] ?? []) {
      const stamps = (row.field_hlc ?? {}) as Record<string, FieldStamp>;
      // A synced row restores exactly the fields that were ever written (the
      // rest are column defaults the insert reproduces); a row that never
      // synced has no stamps, so everything it holds is the athlete's input.
      const synced = Object.keys(stamps).length > 0;
      for (const field of fields) {
        if (!(field in row) || (synced && !stamps[field])) continue;
        const stamp = stamps[field] ?? fallbackStamp(row, exp.exportedAt);
        out.push({
          table,
          id: String(row.id),
          field,
          value: row[field],
          hlc: stamp.hlc,
          origin: stamp.origin,
        });
      }
    }
  }
  return out;
}

export interface RestoreSummary {
  applied: number;
  skipped: number;
  rejected: { mutation: FieldMutation; error: string }[];
}

/** Replay an export through applyMutations, in order, in batches. */
export async function restoreDeviceExport(
  exp: DeviceExport,
  batchSize = 500,
): Promise<RestoreSummary> {
  const mutations = exportToMutations(exp);
  const summary: RestoreSummary = { applied: 0, skipped: 0, rejected: [] };
  for (let i = 0; i < mutations.length; i += batchSize) {
    const batch = mutations.slice(i, i + batchSize);
    // Stamps are months old by design — no drift clamp should touch them, and
    // session_adjustments (server-written) must be restorable too.
    const results: MutationResult[] = await applyMutations(batch, {
      serverWriter: true,
    });
    results.forEach((r, j) => {
      if (r.status === 'applied') summary.applied += 1;
      else if (r.status === 'skipped') summary.skipped += 1;
      else
        summary.rejected.push({
          mutation: batch[j]!,
          error: r.error ?? 'rejected',
        });
    });
  }
  return summary;
}
