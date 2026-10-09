import { query } from '../db';
import { SYNC_TABLE_NAMES } from '@/lib/sync/schema';

// Cursor pull for replicated tables (MZY-206). Everything with
// sync_seq > since, across every replicated table plus sync_id_aliases,
// in sync_seq order — tombstoned rows included (deleted_at set), so a
// device learns about deletes the same way it learns about edits.
//
// sync_seq order is commit order (the sync_stamp trigger serialises writers
// on an advisory lock), so a device that stores `cursor` and asks again from
// there can never skip a row.

export interface PulledChange {
  table: string;
  seq: number;
  row: Record<string, unknown>;
}

export interface PullResult {
  changes: PulledChange[];
  aliases: { aliasId: string; table: string; canonicalId: string }[];
  /** Pass back as `since` next time. */
  cursor: number;
  hasMore: boolean;
}

export async function pullChanges(since: number, limit: number): Promise<PullResult> {
  // Each branch is limited too, so one table with a huge backlog can't make
  // the union materialise every row.
  const branches = SYNC_TABLE_NAMES.map(
    (t) =>
      `(SELECT '${t}' AS tbl, sync_seq, to_jsonb(r) AS row
          FROM public."${t}" r WHERE sync_seq > $1 ORDER BY sync_seq LIMIT $2)`,
  );
  branches.push(
    `(SELECT '_alias' AS tbl, sync_seq,
             jsonb_build_object('aliasId', alias_id, 'table', table_name, 'canonicalId', canonical_id) AS row
        FROM public.sync_id_aliases WHERE sync_seq > $1 ORDER BY sync_seq LIMIT $2)`,
  );
  const { rows } = await query<{ tbl: string; sync_seq: string; row: Record<string, unknown> }>(
    `SELECT tbl, sync_seq, row FROM (${branches.join(' UNION ALL ')}) u
      ORDER BY sync_seq LIMIT $2`,
    [since, limit],
  );

  const changes: PulledChange[] = [];
  const aliases: PullResult['aliases'] = [];
  for (const r of rows) {
    if (r.tbl === '_alias') {
      aliases.push(r.row as PullResult['aliases'][number]);
    } else {
      const { sync_seq: _seq, ...row } = r.row;
      changes.push({ table: r.tbl, seq: Number(r.sync_seq), row });
    }
  }
  const last = rows.at(-1);
  return {
    changes,
    aliases,
    cursor: last ? Number(last.sync_seq) : since,
    hasMore: rows.length === limit,
  };
}
