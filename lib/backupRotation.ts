// Backup retention policy (MZY-209) — pure, so the "which dumps do we delete"
// decision is unit-tested rather than trusted to a shell `ls | tail`.
//
// Every dump lives in one directory as `agon-<YYYYMMDDTHHMMSSZ>.dump`. A dump
// is KEPT if it is either:
//   - one of the newest `keepDaily` dumps, or
//   - the newest dump of its ISO week, for the newest `keepWeekly` weeks that
//     have any dump at all.
// Everything else is deleted. Files not matching the naming pattern (e.g. a
// hand-taken `agon-pre-local-first-*.dump`) are never touched.

const DUMP_NAME = /^agon-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/;

export interface RetentionPolicy {
  keepDaily: number;
  keepWeekly: number;
}

export function dumpFileName(at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return `agon-${stamp}.dump`;
}

export function parseDumpTimestamp(name: string): Date | null {
  const m = DUMP_NAME.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}

// ISO-8601 week key ("2026-W39"), in UTC — the week a dump belongs to.
export function isoWeekKey(at: Date): string {
  const d = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // Thursday decides the ISO year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function selectDumpsToDelete(
  names: string[],
  policy: RetentionPolicy,
): string[] {
  const dumps = names
    .map((name) => ({ name, at: parseDumpTimestamp(name) }))
    .filter((d): d is { name: string; at: Date } => d.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime()); // newest first

  const keep = new Set(dumps.slice(0, policy.keepDaily).map((d) => d.name));

  const weeksSeen = new Set<string>();
  for (const d of dumps) {
    const week = isoWeekKey(d.at);
    if (weeksSeen.has(week)) continue;
    if (weeksSeen.size >= policy.keepWeekly) break;
    weeksSeen.add(week);
    keep.add(d.name); // first seen = newest in that week
  }

  return dumps.filter((d) => !keep.has(d.name)).map((d) => d.name);
}
