import {
  parseLabCsv,
  rowsNeedingReview,
  buildReviewSummary,
  DEFAULT_LAB_CONFIDENCE_THRESHOLD,
  LAB_CSV_HEADER,
} from '@/lib/labImport';

const HEADER = LAB_CSV_HEADER.join(',');

describe('parseLabCsv', () => {
  it('parses a well-formed row', () => {
    const csv = `${HEADER}\n2026-08-20,blood_general,Example Lab,hemoglobin,14.6,,g/dL,13.5,17.5,normal,0.98,report.pdf`;
    const rows = parseLabCsv(csv);
    expect(rows).toEqual([
      {
        date: '2026-08-20',
        panelType: 'blood_general',
        labName: 'Example Lab',
        marker: 'hemoglobin',
        valueNumeric: 14.6,
        valueText: null,
        unit: 'g/dL',
        referenceLow: 13.5,
        referenceHigh: 17.5,
        flag: 'normal',
        confidence: 0.98,
        sourceFile: 'report.pdf',
      },
    ]);
  });

  it('treats a blank confidence as null (manual entry, fully trusted)', () => {
    const csv = `${HEADER}\n2026-08-20,blood_general,,hemoglobin,14.6,,g/dL,13.5,17.5,normal,,report.pdf`;
    expect(parseLabCsv(csv)[0]!.confidence).toBeNull();
  });

  it('accepts a qualitative row with no numeric value', () => {
    const csv = `${HEADER}\n2026-08-20,blood_general,,blood_type,,O+,,,,,,report.pdf`;
    const row = parseLabCsv(csv)[0]!;
    expect(row.valueNumeric).toBeNull();
    expect(row.valueText).toBe('O+');
  });

  it('rejects an unexpected header', () => {
    expect(() => parseLabCsv('a,b,c\n1,2,3')).toThrow(/unexpected header/);
  });

  it('rejects a non-YYYY-MM-DD date', () => {
    const csv = `${HEADER}\n08/20/2026,blood_general,,hemoglobin,14.6,,g/dL,,,,,`;
    expect(() => parseLabCsv(csv)).toThrow(/is not YYYY-MM-DD/);
  });

  it('rejects an invalid flag', () => {
    const csv = `${HEADER}\n2026-08-20,blood_general,,hemoglobin,14.6,,g/dL,,,elevated,,`;
    expect(() => parseLabCsv(csv)).toThrow(/invalid flag/);
  });

  it('rejects confidence outside [0, 1]', () => {
    const csv = `${HEADER}\n2026-08-20,blood_general,,hemoglobin,14.6,,g/dL,,,,1.5,`;
    expect(() => parseLabCsv(csv)).toThrow(/outside \[0, 1\]/);
  });

  it('rejects a row with the wrong cell count', () => {
    expect(() => parseLabCsv(`${HEADER}\n2026-08-20,blood_general`)).toThrow(/has \d+ cells/);
  });
});

describe('rowsNeedingReview', () => {
  const base = {
    date: '2026-08-20',
    panelType: 'blood_general',
    labName: null,
    marker: 'ldl',
    valueNumeric: 145,
    valueText: null,
    unit: 'mg/dL',
    referenceLow: 0,
    referenceHigh: 130,
    flag: 'high' as const,
    sourceFile: null,
  };

  it('flags rows below the threshold', () => {
    const rows = [
      { ...base, confidence: 0.6 },
      { ...base, confidence: 0.95 },
    ];
    expect(rowsNeedingReview(rows, DEFAULT_LAB_CONFIDENCE_THRESHOLD)).toHaveLength(1);
  });

  it('never flags a row with null confidence (manual entry, fully trusted)', () => {
    expect(rowsNeedingReview([{ ...base, confidence: null }], DEFAULT_LAB_CONFIDENCE_THRESHOLD)).toEqual([]);
  });
});

describe('buildReviewSummary', () => {
  it('reports a clean import when nothing needs review', () => {
    expect(buildReviewSummary([], 0.85)).toMatch(/no review needed/);
  });

  it('lists each low-confidence row with its confidence percentage', () => {
    const summary = buildReviewSummary(
      [
        {
          date: '2026-08-20',
          panelType: 'blood_general',
          labName: null,
          marker: 'ldl',
          valueNumeric: 145,
          valueText: null,
          unit: 'mg/dL',
          referenceLow: 0,
          referenceHigh: 130,
          flag: 'high',
          confidence: 0.6,
          sourceFile: null,
        },
      ],
      0.85,
    );
    expect(summary).toContain('ldl');
    expect(summary).toContain('60%');
  });
});
