import {
  dumpFileName,
  isoWeekKey,
  parseDumpTimestamp,
  selectDumpsToDelete,
} from '@/lib/backupRotation';

// One dump per day at 03:00 UTC, newest last.
function daily(fromIso: string, days: number): string[] {
  const start = new Date(fromIso).getTime();
  return Array.from({ length: days }, (_, i) =>
    dumpFileName(new Date(start + i * 86_400_000)),
  );
}

describe('dump naming', () => {
  it('round-trips a timestamp through the file name', () => {
    const at = new Date('2026-09-24T21:04:12Z');
    expect(dumpFileName(at)).toBe('agon-20260924T210412Z.dump');
    expect(parseDumpTimestamp(dumpFileName(at))).toEqual(at);
  });

  it('ignores files outside the pattern', () => {
    expect(
      parseDumpTimestamp('agon-pre-local-first-20260924T210412Z.dump'),
    ).toBeNull();
    expect(parseDumpTimestamp('agon-20260924T210412Z.dump.tmp')).toBeNull();
  });
});

describe('isoWeekKey', () => {
  it('uses ISO weeks (Monday start, Thursday decides the year)', () => {
    expect(isoWeekKey(new Date('2026-09-21T00:00:00Z'))).toBe('2026-W39'); // Mon
    expect(isoWeekKey(new Date('2026-09-27T23:59:59Z'))).toBe('2026-W39'); // Sun
    expect(isoWeekKey(new Date('2026-09-28T00:00:00Z'))).toBe('2026-W40');
    expect(isoWeekKey(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
  });
});

describe('selectDumpsToDelete', () => {
  it('deletes nothing while under both limits', () => {
    expect(
      selectDumpsToDelete(daily('2026-09-20T03:00:00Z', 5), {
        keepDaily: 14,
        keepWeekly: 8,
      }),
    ).toEqual([]);
  });

  it('keeps the newest N daily plus the newest dump of each of the newest M weeks', () => {
    const names = daily('2026-06-01T03:00:00Z', 70); // Mon 1 Jun .. Sun 9 Aug, 10 full weeks
    const toDelete = selectDumpsToDelete(names, {
      keepDaily: 7,
      keepWeekly: 4,
    });
    const kept = names.filter((n) => !toDelete.includes(n));

    // Newest 7 = the whole last week (3–9 Aug); 4 weekly keeps = that week
    // (its Sunday is already kept) plus the Sundays of the three weeks before.
    expect(kept).toEqual([
      'agon-20260719T030000Z.dump',
      'agon-20260726T030000Z.dump',
      'agon-20260802T030000Z.dump',
      ...daily('2026-08-03T03:00:00Z', 7),
    ]);
    expect(toDelete).toHaveLength(70 - kept.length);
  });

  it('never touches files outside the naming pattern', () => {
    const names = [
      ...daily('2026-06-01T03:00:00Z', 30),
      'agon-pre-local-first-20260924T210412Z.dump',
      'notes.txt',
    ];
    const toDelete = selectDumpsToDelete(names, {
      keepDaily: 1,
      keepWeekly: 1,
    });
    expect(toDelete).not.toContain(
      'agon-pre-local-first-20260924T210412Z.dump',
    );
    expect(toDelete).not.toContain('notes.txt');
    expect(toDelete).toHaveLength(29);
  });

  it('is order-independent', () => {
    const names = daily('2026-06-01T03:00:00Z', 40);
    const policy = { keepDaily: 5, keepWeekly: 3 };
    expect(selectDumpsToDelete([...names].reverse(), policy).sort()).toEqual(
      selectDumpsToDelete(names, policy).sort(),
    );
  });
});
