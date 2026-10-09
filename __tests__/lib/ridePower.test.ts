import {
  diffRidePower,
  formatCurveDuration,
  formatPowerMetricsField,
  formatRidePowerField,
  formatPowerLabel,
  isPowerCorrected,
} from '@/lib/ridePower';
import { listAfterEpoch } from '@/services/strava/ridePowerBackfill';
import { NO_RIDE_POWER } from '@/lib/types';
import type { StoredRidePower } from '@/services/ridePower';

describe('diffRidePower', () => {
  it('lists only the fields that change', () => {
    const changes = diffRidePower(NO_RIDE_POWER, {
      ...NO_RIDE_POWER,
      avg_power_w: 104,
      kilojoules: 471.2,
      power_source: 'estimated',
    });
    expect(changes).toEqual([
      { field: 'avg_power_w', from: null, to: 104 },
      { field: 'kilojoules', from: null, to: 471.2 },
      { field: 'power_source', from: null, to: 'estimated' },
    ]);
  });

  it('is empty when nothing changed (idempotent re-run)', () => {
    const p = {
      ...NO_RIDE_POWER,
      avg_power_w: 98,
      power_source: 'estimated' as const,
    };
    expect(diffRidePower(p, { ...p })).toEqual([]);
  });
});

describe('isPowerCorrected', () => {
  it('is true when any power column was hand-corrected', () => {
    expect(isPowerCorrected(['distance_km', 'kilojoules'])).toBe(true);
    expect(isPowerCorrected(['power_source'])).toBe(true);
  });

  it('ignores corrections to other columns', () => {
    expect(isPowerCorrected(['distance_km', 'duration_s'])).toBe(false);
    expect(isPowerCorrected([])).toBe(false);
  });
});

describe('formatPowerLabel', () => {
  it('never hides the provenance', () => {
    expect(formatPowerLabel(104, 'estimated')).toBe('104 W (est.)');
    expect(formatPowerLabel(140, 'manual')).toBe('140 W (manual)');
    expect(formatPowerLabel(212, 'device')).toBe('212 W');
  });

  it('is null without a value or without a provenance', () => {
    expect(formatPowerLabel(null, 'estimated')).toBeNull();
    expect(formatPowerLabel(100, null)).toBeNull();
  });
});

describe('listAfterEpoch', () => {
  const ride = (startedAt: string | null, date: string): StoredRidePower => ({
    id: 'x',
    externalId: '1',
    date,
    startedAt,
    correctedFields: [],
    ...NO_RIDE_POWER,
  });

  it('starts a day before the earliest stored ride', () => {
    const after = listAfterEpoch([
      ride('2026-09-29T08:00:00.000Z', '2026-09-29'),
      ride('2026-09-25T10:09:36.000Z', '2026-09-25'),
    ]);
    expect(after).toBe(Date.parse('2026-09-24T10:09:36.000Z') / 1000);
  });

  it('falls back to the date and is undefined with no rides', () => {
    expect(listAfterEpoch([ride(null, '2026-09-25')])).toBe(
      Date.parse('2026-09-24') / 1000,
    );
    expect(listAfterEpoch([])).toBeUndefined();
  });
});

describe('formatRidePowerField', () => {
  it("labels Strava's estimate in the field label", () => {
    expect(
      formatRidePowerField({
        avgW: 104,
        maxW: null,
        kj: 471.2,
        source: 'estimated',
      }),
    ).toEqual({ label: 'Power (estimated)', value: '104 W · 471 kJ' });
  });

  it('shows avg / max for a meter ride without a provenance tag', () => {
    expect(
      formatRidePowerField({
        avgW: 180,
        maxW: 712,
        kj: null,
        source: 'device',
      }),
    ).toEqual({ label: 'Avg / max power', value: '180 / 712 W' });
  });

  it('tags hand-logged power and hides an empty field', () => {
    expect(
      formatRidePowerField({
        avgW: 140,
        maxW: null,
        kj: null,
        source: 'manual',
      })?.label,
    ).toBe('Power (hand-logged)');
    expect(
      formatRidePowerField({
        avgW: null,
        maxW: null,
        kj: null,
        source: 'manual',
      }),
    ).toBeNull();
  });
});

describe('formatPowerMetricsField (MZY-269)', () => {
  it('shows NP, IF and TSS when an FTP anchored them', () => {
    expect(
      formatPowerMetricsField({ npW: 231, intensityFactor: 0.84, tss: 71.6 }),
    ).toEqual({ label: 'NP · IF · TSS', value: 'NP 231 W · IF 0.84 · TSS 72' });
  });

  it('says why IF/TSS are missing instead of hiding it', () => {
    expect(
      formatPowerMetricsField({ npW: 231, intensityFactor: null, tss: null })
        .value,
    ).toBe('NP 231 W (no FTP set)');
  });
});

describe('formatCurveDuration', () => {
  it.each([
    [1, '1 s'],
    [30, '30 s'],
    [60, '1 min'],
    [1200, '20 min'],
    [3600, '1 h'],
    [5400, '1.5 h'],
    [7200, '2 h'],
  ])('%i s → %s', (s, label) => {
    expect(formatCurveDuration(s)).toBe(label);
  });
});
