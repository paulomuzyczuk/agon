import { parseAdjustArgs } from '@/lib/sessionAdjustArgs';

// Arguments of `pnpm session:adjust` (MZY-406, install audit F-28): move a
// session's day AND time, and address one that was already moved.

describe('parseAdjustArgs', () => {
  it('keeps the old form working: program date, kind, overrides', () => {
    expect(
      parseAdjustArgs([
        '2026-08-22',
        'run',
        '--date=2026-08-23',
        '--km=25',
        '--note=swapped',
      ]),
    ).toEqual({
      dateISO: '2026-08-22',
      kind: 'run',
      clear: false,
      byCalendar: false,
      patch: { date: '2026-08-23', targetDistanceKm: 25, note: 'swapped' },
    });
  });

  it('takes a start time, alone or with a day move', () => {
    expect(parseAdjustArgs(['2026-10-29', 'run', '--at=18:30'])).toMatchObject({
      startTime: '18:30',
      patch: {},
    });
    expect(
      parseAdjustArgs(['2026-10-29', 'run', '--date=2026-10-30', '--at=07:05']),
    ).toMatchObject({ startTime: '07:05', patch: { date: '2026-10-30' } });
  });

  it('--calendar addresses the session by where it sits now', () => {
    expect(
      parseAdjustArgs(['2026-10-29', 'run', '--calendar', '--at=19:00']),
    ).toMatchObject({ byCalendar: true });
  });

  it('accepts bike sessions', () => {
    expect(parseAdjustArgs(['2026-10-29', 'bike', '--at=08:30']).kind).toBe(
      'bike',
    );
  });

  it('--clear needs no override', () => {
    expect(parseAdjustArgs(['2026-10-29', 'run', '--clear']).clear).toBe(true);
  });

  it.each(['25:00', '7:30', '18:60', 'noon', ''])(
    'rejects a malformed --at (%s)',
    (at) => {
      expect(() =>
        parseAdjustArgs(['2026-10-29', 'run', `--at=${at}`]),
      ).toThrow(/--at must be a 24-hour time/);
    },
  );

  it('rejects bad dates, kinds and distances, naming the flag and the value', () => {
    expect(() => parseAdjustArgs(['29-10-2026', 'run', '--km=5'])).toThrow(
      /session date.*29-10-2026/,
    );
    expect(() =>
      parseAdjustArgs(['2026-10-29', 'run', '--date=tomorrow']),
    ).toThrow(/--date.*tomorrow/);
    expect(() => parseAdjustArgs(['2026-10-29', 'swim', '--km=5'])).toThrow(
      /kind.*swim/,
    );
    expect(() => parseAdjustArgs(['2026-10-29', 'run', '--km=-3'])).toThrow(
      /--km.*-3/,
    );
  });

  it('refuses to do nothing', () => {
    expect(() => parseAdjustArgs(['2026-10-29', 'run'])).toThrow(
      /nothing to adjust/,
    );
    expect(() => parseAdjustArgs(['2026-10-29'])).toThrow(/usage/);
  });
});
