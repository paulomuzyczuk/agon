import { compareHlc } from './hlc';

// The one merge rule for athlete-authored data (MZY-28 decision 2, MZY-206).
// Pure; used by the server's push path (services/sync/apply.ts) for every
// write to a replicated table — PWA devices, the lab-PDF import, and (phase 4)
// Google Calendar.
//
// Per FIELD, not per row: two devices editing different fields of the same
// meal both keep their change. For the same field:
//   1. human beats machine, regardless of clock — a lab re-import never
//      overwrites a value the athlete corrected by hand (generalises the
//      Calendar "hand edits win" rule, a40c01c);
//   2. otherwise the later HLC wins; the HLC's node id breaks exact ties
//      deterministically, so every replica converges on the same value;
//   3. an identical stamp is a replay — skipped, so pushes are idempotent.
//
// Deletion is just the `deleted_at` field merged by the same rule. A delete
// and a concurrent edit of another field both apply: the row stays deleted
// with the edited value underneath. Only a later write of deleted_at = null
// (an explicit restore) brings it back.

export type Origin = 'human' | 'machine';

export interface FieldStamp {
  hlc: string;
  origin: Origin;
}

export type FieldStamps = Record<string, FieldStamp>;

/** Should `incoming` replace the field currently stamped `current`? */
export function mergeField(current: FieldStamp | undefined, incoming: FieldStamp): boolean {
  if (!current) return true;
  if (current.origin === 'human' && incoming.origin === 'machine') return false;
  if (current.origin === 'machine' && incoming.origin === 'human') return true;
  return compareHlc(incoming.hlc, current.hlc) > 0;
}

export interface FieldWrite {
  field: string;
  value: unknown;
  stamp: FieldStamp;
}

export interface RowMerge {
  /** Field values to write (only the winners). */
  apply: Record<string, unknown>;
  /** The row's full stamp map after the merge. */
  stamps: FieldStamps;
  /** Fields whose incoming write lost (or was a replay). */
  skipped: string[];
  /** Per write, in input order: did it win? */
  accepted: boolean[];
}

/** Fold a batch of field writes for one row into its current stamps, in order. */
export function mergeRow(current: FieldStamps, writes: FieldWrite[]): RowMerge {
  const stamps: FieldStamps = { ...current };
  const apply: Record<string, unknown> = {};
  const skipped: string[] = [];
  const accepted: boolean[] = [];
  for (const w of writes) {
    const wins = mergeField(stamps[w.field], w.stamp);
    accepted.push(wins);
    if (wins) {
      stamps[w.field] = w.stamp;
      apply[w.field] = w.value;
    } else {
      skipped.push(w.field);
    }
  }
  return { apply, stamps, skipped, accepted };
}
