import type { LabResultTrendRow } from './marts';

// Pure trend-shaping for the /health lab-results chart. Mirrors sihha's
// clinicianCharts.ts buildScaleTrends/latestClassifications (public repo
// services/clinicianCharts.ts): different markers use different units and
// scales, so nothing plots them on a shared axis directly. sihha solves this
// for psychometrics with percentile (the one cross-instrument comparable
// unit); labs don't have a percentile, but they do have a reference range —
// this normalizes each value to its position within [reference_low,
// reference_high] as a 0–100 axis (0 = low bound, 100 = high bound), the
// direct analog of buildScaleTrends' [min, max] normalization. A marker
// without both bounds can't be normalized and doesn't chart, same as a
// psychometric measure without a percentile.

const DISPLAY_MIN = -50;
const DISPLAY_MAX = 150;

export interface LabTrendPoint {
  date: string;
  /** Position within [reference_low, reference_high] as 0–100, clamped to a wide display band. */
  value: number | null;
  /** Instrument-native value, for the legend/tooltip. */
  raw: number | null;
  unit: string | null;
  flag: 'low' | 'normal' | 'high' | 'abnormal' | null;
  /** True when the lab-ingestion skill's extraction confidence fell below threshold. */
  needsReview: boolean;
}

export interface LabTrendSeries {
  /** `${panelType} · ${marker}` — disambiguates a marker that appears under more than one panel type. */
  key: string;
  label: string;
  /** panel_type — the chip-toggle grouping, mirrors sihha's instrument grouping. */
  group: string;
  points: LabTrendPoint[];
}

function seriesKey(row: Pick<LabResultTrendRow, 'panelType' | 'marker'>): string {
  return `${row.panelType} · ${row.marker}`;
}

function normalize(value: number, low: number, high: number): number | null {
  const span = high - low;
  if (span <= 0) return null;
  const pct = ((value - low) / span) * 100;
  return Math.min(DISPLAY_MAX, Math.max(DISPLAY_MIN, pct));
}

function isChartable(
  row: LabResultTrendRow,
): row is LabResultTrendRow & { valueNumeric: number; referenceLow: number; referenceHigh: number } {
  return (
    row.valueNumeric != null &&
    row.referenceLow != null &&
    row.referenceHigh != null &&
    row.referenceHigh > row.referenceLow
  );
}

/**
 * One line per (panel_type, marker) with both reference bounds, aligned on
 * the shared list of dates any charted result falls on (one point per date,
 * gaps where that marker wasn't measured that date). Mirrors
 * buildPsychometricTrends' "align on the shared year list" shape, with dates
 * instead of years since lab panels aren't necessarily yearly.
 */
export function buildLabTrends(rows: LabResultTrendRow[]): {
  dates: string[];
  series: LabTrendSeries[];
} {
  const charted = rows.filter(isChartable);
  const dates = [...new Set(charted.map((r) => r.date))].sort();

  const byMarker = new Map<string, typeof charted>();
  for (const row of charted) {
    const key = seriesKey(row);
    const bucket = byMarker.get(key);
    if (bucket) bucket.push(row);
    else byMarker.set(key, [row]);
  }

  const series: LabTrendSeries[] = [...byMarker.entries()].map(([key, group]) => ({
    key,
    label: group[0]!.marker,
    group: group[0]!.panelType,
    points: dates.map((date) => {
      const match = group.find((r) => r.date === date);
      if (!match) {
        return { date, value: null, raw: null, unit: null, flag: null, needsReview: false };
      }
      return {
        date,
        value: normalize(match.valueNumeric, match.referenceLow, match.referenceHigh),
        raw: match.valueNumeric,
        unit: match.unit,
        flag: match.flag,
        needsReview: match.needsReview,
      };
    }),
  }));

  return { dates, series };
}

/** The most recent reading per charted (panel_type, marker), for the chart's legend. */
export function latestLabReadings(rows: LabResultTrendRow[]): Map<
  string,
  {
    date: string;
    raw: number;
    unit: string | null;
    flag: LabResultTrendRow['flag'];
    needsReview: boolean;
  }
> {
  const latest = new Map<
    string,
    {
      date: string;
      raw: number;
      unit: string | null;
      flag: LabResultTrendRow['flag'];
      needsReview: boolean;
    }
  >();
  for (const row of rows.filter(isChartable)) {
    const key = seriesKey(row);
    const current = latest.get(key);
    if (!current || row.date > current.date) {
      latest.set(key, {
        date: row.date,
        raw: row.valueNumeric,
        unit: row.unit,
        flag: row.flag,
        needsReview: row.needsReview,
      });
    }
  }
  return latest;
}
