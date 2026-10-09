import {
  localGearId,
  hrmForDate,
  hrmForRun,
  POLAR_H9,
  GARMIN_HRM_200,
  MERIDA_SILEX_400,
  SEED_GEAR,
} from '@/lib/gear';

// The pure id-minting rule: one deterministic id per item name.
describe('localGearId', () => {
  it('slugifies a name into a stable local id', () => {
    expect(localGearId('Saucony Endorphin Speed 4')).toBe(
      'local:saucony-endorphin-speed-4',
    );
  });

  it('is deterministic — same name always yields the same id', () => {
    expect(localGearId('Nike Pegasus 41')).toBe(localGearId('Nike Pegasus 41'));
  });

  it('normalizes case, punctuation, and repeated separators', () => {
    expect(localGearId('  ASICS   Novablast_3!! ')).toBe(
      'local:asics-novablast-3',
    );
  });

  it('strips diacritics so accented names still slug cleanly', () => {
    expect(localGearId('Söcönï Tríumph')).toBe('local:soconi-triumph');
  });

  it('matches the hard-coded HRM ids (config stays consistent with the rule)', () => {
    expect(localGearId(POLAR_H9.name)).toBe(POLAR_H9.gear_id);
    expect(localGearId(GARMIN_HRM_200.name)).toBe(GARMIN_HRM_200.gear_id);
  });

  it('throws on a name with no slug-able characters', () => {
    expect(() => localGearId('!!!')).toThrow(/no slug-able/);
  });
});

// The HRM timeline: Polar H9 through June 2026, Garmin HRM 200 from July 2026.
describe('hrmForDate', () => {
  it('returns the Polar H9 for runs up to and including 2026-06-30', () => {
    expect(hrmForDate('2026-03-25')?.gear_id).toBe('local:polar-h9');
    expect(hrmForDate('2026-06-30')?.gear_id).toBe('local:polar-h9');
  });

  it('returns the Garmin HRM 200 from 2026-07-01 onward', () => {
    expect(hrmForDate('2026-07-01')?.gear_id).toBe('local:garmin-hrm-200');
    expect(hrmForDate('2026-09-15')?.gear_id).toBe('local:garmin-hrm-200');
  });

  it('categorizes both HRMs as hrm', () => {
    expect(hrmForDate('2026-05-01')?.category).toBe('hrm');
    expect(hrmForDate('2026-08-01')?.category).toBe('hrm');
  });
});

describe('hrmForRun', () => {
  it('assigns the date-based HRM when the run has HR data', () => {
    expect(hrmForRun(152, '2026-05-01')?.gear_id).toBe('local:polar-h9');
    expect(hrmForRun(148, '2026-08-01')?.gear_id).toBe('local:garmin-hrm-200');
  });

  it('assigns no HRM when the run has no HR data (assume ran without a strap)', () => {
    expect(hrmForRun(null, '2026-05-01')).toBeNull();
    expect(hrmForRun(null, '2026-08-01')).toBeNull();
  });
});

// The bike (MZY-168): a single current bike, with the wheel circumference the
// BLE CSC speed sensor's rev-count math needs.
describe('MERIDA_SILEX_400', () => {
  it('is categorized as bike with its measured wheel circumference', () => {
    expect(MERIDA_SILEX_400.category).toBe('bike');
    expect(MERIDA_SILEX_400.wheelCircumferenceMm).toBe(2242);
  });

  it('has a gear_id matching the localGearId rule (config stays consistent with the rule)', () => {
    expect(localGearId(MERIDA_SILEX_400.name)).toBe(MERIDA_SILEX_400.gear_id);
  });

  it('is seeded alongside the HRMs', () => {
    expect(SEED_GEAR).toContain(MERIDA_SILEX_400);
  });
});
