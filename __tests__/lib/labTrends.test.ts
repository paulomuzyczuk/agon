import { buildLabTrends, latestLabReadings } from '@/lib/labTrends';
import type { LabResultTrendRow } from '@/lib/marts';

function row(overrides: Partial<LabResultTrendRow>): LabResultTrendRow {
  return {
    date: '2026-01-01',
    panelType: 'blood_general',
    marker: 'hemoglobin',
    valueNumeric: 15,
    unit: 'g/dL',
    referenceLow: 13,
    referenceHigh: 17,
    flag: 'normal',
    needsReview: false,
    ...overrides,
  };
}

describe('buildLabTrends', () => {
  it('normalizes a value to its position within the reference range', () => {
    const { series } = buildLabTrends([
      row({ valueNumeric: 15, referenceLow: 13, referenceHigh: 17 }), // (15-13)/4*100 = 50
    ]);
    expect(series).toHaveLength(1);
    expect(series[0]!.points[0]!.value).toBeCloseTo(50, 5);
    expect(series[0]!.points[0]!.raw).toBe(15);
  });

  it('places the low reference bound at 0 and the high bound at 100', () => {
    const { series } = buildLabTrends([
      row({ date: '2026-01-01', valueNumeric: 13 }),
      row({ date: '2026-01-02', valueNumeric: 17 }),
    ]);
    const points = series[0]!.points;
    expect(points[0]!.value).toBeCloseTo(0, 5);
    expect(points[1]!.value).toBeCloseTo(100, 5);
  });

  it('clamps extreme excursions to the display band instead of blowing out the axis', () => {
    const { series } = buildLabTrends([
      row({ valueNumeric: 1000, referenceLow: 0, referenceHigh: 10 }),
    ]);
    expect(series[0]!.points[0]!.value).toBe(150);
  });

  it('excludes a marker missing either reference bound', () => {
    const { series } = buildLabTrends([
      row({ marker: 'no_range', referenceLow: null, referenceHigh: null }),
    ]);
    expect(series).toHaveLength(0);
  });

  it('excludes a marker with a qualitative (non-numeric) value', () => {
    const { series } = buildLabTrends([
      row({ marker: 'blood_type', valueNumeric: null }),
    ]);
    expect(series).toHaveLength(0);
  });

  it('keys series by panel_type + marker so the same marker under two panel types stays distinct', () => {
    const { series } = buildLabTrends([
      row({ panelType: 'blood_general', marker: 'creatinine' }),
      row({ panelType: 'kidney_panel', marker: 'creatinine' }),
    ]);
    expect(series.map((s) => s.key).sort()).toEqual([
      'blood_general · creatinine',
      'kidney_panel · creatinine',
    ]);
  });

  it('aligns series on the shared date list, leaving gaps where a marker was not measured', () => {
    const { dates, series } = buildLabTrends([
      row({ marker: 'hemoglobin', date: '2026-01-01' }),
      row({ marker: 'ldl', date: '2026-02-01', referenceLow: 0, referenceHigh: 130 }),
    ]);
    expect(dates).toEqual(['2026-01-01', '2026-02-01']);
    const hemoglobin = series.find((s) => s.label === 'hemoglobin')!;
    expect(hemoglobin.points[0]!.value).not.toBeNull();
    expect(hemoglobin.points[1]!.value).toBeNull();
  });
});

describe('latestLabReadings', () => {
  it('keeps only the most recent reading per (panel_type, marker)', () => {
    const latest = latestLabReadings([
      row({ date: '2026-01-01', valueNumeric: 14 }),
      row({ date: '2026-06-01', valueNumeric: 15.5 }),
    ]);
    const reading = latest.get('blood_general · hemoglobin');
    expect(reading?.date).toBe('2026-06-01');
    expect(reading?.raw).toBe(15.5);
  });

  it('omits markers that never had both reference bounds', () => {
    const latest = latestLabReadings([
      row({ marker: 'no_range', referenceLow: null, referenceHigh: null }),
    ]);
    expect(latest.has('blood_general · no_range')).toBe(false);
  });
});
