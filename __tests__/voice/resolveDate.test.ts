import { resolveDate } from '@/services/voice/ingest';

describe('resolveDate', () => {
  it('keeps a model date on or before the capture date', () => {
    expect(resolveDate('2026-08-24', '2026-08-25')).toBe('2026-08-24');
    expect(resolveDate('2026-08-25', '2026-08-25')).toBe('2026-08-25');
  });

  it('rejects a model date after the capture date (relative words resolved against the processing day)', () => {
    // "yesterday" in a note captured 2026-07-24 but parsed on 2026-09-24.
    expect(resolveDate('2026-09-23', '2026-07-24')).toBe('2026-07-24');
  });

  it('falls back to the capture date for a missing or malformed model date', () => {
    expect(resolveDate(null, '2026-08-25')).toBe('2026-08-25');
    expect(resolveDate('yesterday', '2026-08-25')).toBe('2026-08-25');
    expect(resolveDate('2026-13-45', '2026-08-25')).toBe('2026-08-25');
  });
});
