import {
  athleteLocalParts,
  hmsToSecondsOfDay,
  athleteLocalToUtcISO,
  captureDate,
} from '@/lib/time';

// Athlete trains in Berlin (Europe/Berlin), which observes DST:
// CEST = UTC+2 in summer, CET = UTC+1 in winter.
const TZ = 'Europe/Berlin';

describe('athleteLocalParts', () => {
  it('shifts a UTC instant to local wall-clock (CEST, +2)', () => {
    // 09:00Z on Aug 1 → 11:00 local
    expect(athleteLocalParts('2026-08-01T09:00:00.000Z', TZ)).toEqual({
      date: '2026-08-01',
      hms: '11:00:00',
      secondsOfDay: 11 * 3600,
    });
  });

  it('rolls forward to the next local day when UTC is late evening', () => {
    // 22:30Z on the 1st → 00:30 local on the 2nd (CEST)
    const parts = athleteLocalParts('2026-08-01T22:30:00.000Z', TZ);
    expect(parts.date).toBe('2026-08-02');
    expect(parts.hms).toBe('00:30:00');
    expect(parts.secondsOfDay).toBe(30 * 60);
  });

  it('is DST-aware: winter uses CET (+1), not the summer offset', () => {
    // 09:00Z on Jan 15 → 10:00 local (CET), i.e. +1 not +2
    expect(athleteLocalParts('2026-01-15T09:00:00.000Z', TZ).hms).toBe(
      '10:00:00',
    );
  });

  it('throws on an invalid instant', () => {
    expect(() => athleteLocalParts('nope', TZ)).toThrow();
  });
});

describe('athleteLocalToUtcISO', () => {
  it('converts a naive local timestamp to the UTC instant (CEST)', () => {
    // 23:30 local on Aug 1 (CEST, +2) → 21:30Z on Aug 1
    expect(athleteLocalToUtcISO('2026-08-01T23:30:00.000', TZ)).toBe(
      '2026-08-01T21:30:00.000Z',
    );
  });

  it('converts using the winter offset (CET) for a January local time', () => {
    // 23:30 local on Jan 1 (CET, +1) → 22:30Z on Jan 1
    expect(athleteLocalToUtcISO('2026-01-01T23:30:00.000', TZ)).toBe(
      '2026-01-01T22:30:00.000Z',
    );
  });

  it('is the inverse of athleteLocalParts for the same zone', () => {
    const utc = athleteLocalToUtcISO('2026-08-01T06:00:00.000', TZ);
    expect(athleteLocalParts(utc, TZ).hms).toBe('06:00:00');
  });

  it('throws on garbage', () => {
    expect(() => athleteLocalToUtcISO('nope', TZ)).toThrow();
  });
});

describe('hmsToSecondsOfDay', () => {
  it('parses HH:mm:ss and HH:mm', () => {
    expect(hmsToSecondsOfDay('06:00:30')).toBe(6 * 3600 + 30);
    expect(hmsToSecondsOfDay('06:05')).toBe(6 * 3600 + 5 * 60);
  });

  it('throws on malformed input', () => {
    expect(() => hmsToSecondsOfDay('6h')).toThrow();
  });
});

describe('captureDate (MZY-205)', () => {
  const TZ = 'Europe/Berlin';
  const NOW = '2026-03-02T09:00:00.000Z'; // processing happens next morning

  it('an explicit date always wins', () => {
    expect(captureDate('2026-02-27', '2026-03-01T22:30:00Z', TZ, NOW)).toBe(
      '2026-02-27',
    );
  });

  it('otherwise the athlete-local day of capturedAt, never the processing day', () => {
    // 23:30 Berlin on 1 Mar — the UTC date is also 1 Mar, the server day is 2 Mar
    expect(captureDate(undefined, '2026-03-01T22:30:00Z', TZ, NOW)).toBe(
      '2026-03-01',
    );
    // 00:30 Berlin on 2 Mar is still 1 Mar in UTC — must be 2 Mar
    expect(captureDate(undefined, '2026-03-01T23:30:00Z', TZ, NOW)).toBe(
      '2026-03-02',
    );
  });

  it('falls back to now only when nothing was captured (legacy callers)', () => {
    expect(captureDate(undefined, undefined, TZ, NOW)).toBe('2026-03-02');
  });
});
