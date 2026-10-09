// Pure training-load model (CTL / ATL / TSB), DB-free + unit-tested. Agon's
// reimplementation of Strava's paywalled "Fitness & Freshness" and the classic
// TrainingPeaks Performance Management Chart, built on the Banister
// impulse-response model (Busso 2003; Banister 1991). Credit GoldenCheetah /
// sweatpy for the reference implementations — formulas only, no code copied
// (both are GPL-3.0; see CREDITS.md #1).
//
// Daily training load is the SUM of each day's per-activity Relative Effort
// (Banister TRIMP, lib/relativeEffort.ts). From the daily-load series we derive
// three exponentially-weighted moving averages:
//
//   CTL (Fitness)  — chronic training load, 42-day time constant. Slow to build,
//                    slow to shed. The fitness you've banked.
//   ATL (Fatigue)  — acute training load, 7-day time constant. Spikes fast after
//                    a hard session, recovers within a week.
//   TSB (Form)     — training stress balance = CTL − ATL. Negative = fatigued /
//                    building; positive = fresh / tapered.
//
// The EWMA recurrence is sequential (each day depends on the previous day), so it
// is computed here over a CONTINUOUS date spine where rest days contribute a load
// of 0 — the averages decay on days off, which is the whole point. A dbt
// recursive CTE could express this but would be opaque and hard to test; keeping
// the recurrence in a pure, unit-tested function (materialized to a table by a
// backfill script) mirrors lib/relativeEffort.ts and the project's house style.

/** One day of training load (input): a calendar date and its summed load. */
export interface DailyLoad {
  /** Calendar date, YYYY-MM-DD (athlete-local). */
  date: string;
  /** Summed training load for the day (Σ Relative Effort). 0 on rest days. */
  load: number;
}

/** One day of the Performance Management Chart (output). */
export interface TrainingLoadDay {
  date: string;
  load: number;
  /** Chronic training load (Fitness), rounded to 1 dp. */
  ctl: number;
  /** Acute training load (Fatigue), rounded to 1 dp. */
  atl: number;
  /** Training stress balance (Form) = CTL − ATL, rounded to 1 dp. */
  tsb: number;
}

export interface TrainingLoadOptions {
  /** CTL time constant in days (TrainingPeaks default 42). */
  ctlDays?: number;
  /** ATL time constant in days (TrainingPeaks default 7). */
  atlDays?: number;
  /**
   * First day of the spine (YYYY-MM-DD). Defaults to the earliest load date.
   * The EWMAs seed at 0 and ramp up, so a start well before the period of
   * interest (≳ 2× ctlDays) makes the seed immaterial.
   */
  start?: string;
  /** Last day of the spine (YYYY-MM-DD). Defaults to the latest load date. */
  end?: string;
  /**
   * How to date Form. TrainingPeaks defines Form as YESTERDAY's Fitness minus
   * yesterday's Fatigue — the freshness you carry INTO a day, before that day's
   * session. 'same-day' uses the current day's CTL/ATL instead. Default 'prev-day'.
   */
  tsbMode?: 'prev-day' | 'same-day';
}

const DAY_MS = 86_400_000;

/** Parse a YYYY-MM-DD date to a UTC-midnight epoch (TZ-free arithmetic). */
function dayToUtc(date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`trainingLoad: invalid date '${date}'`);
  return ms;
}

/** Format a UTC-midnight epoch back to YYYY-MM-DD. */
function utcToDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * Build the Performance Management Chart (per-day CTL/ATL/TSB) from a sparse
 * daily-load series. Missing calendar days between start and end are filled with
 * load 0 (rest days) so the EWMAs decay correctly.
 *
 * EWMA recurrence (α = 1/timeConstant): value_t = value_{t-1} + α·(load_t −
 * value_{t-1}), seeded at 0 before the first day.
 *
 * Returns one row per calendar day in [start, end], chronologically. Empty input
 * with no explicit start/end yields an empty array.
 */
export function computeTrainingLoad(
  daily: DailyLoad[],
  opts: TrainingLoadOptions = {},
): TrainingLoadDay[] {
  const ctlDays = opts.ctlDays ?? 42;
  const atlDays = opts.atlDays ?? 7;
  const tsbMode = opts.tsbMode ?? 'prev-day';
  if (ctlDays <= 0 || atlDays <= 0) {
    throw new Error('trainingLoad: time constants must be positive');
  }

  // Collapse to one load per date (defensive — caller usually pre-aggregates).
  const loadByDate = new Map<string, number>();
  for (const d of daily) {
    loadByDate.set(d.date, (loadByDate.get(d.date) ?? 0) + d.load);
  }

  const dates = [...loadByDate.keys()].sort();
  const start = opts.start ?? dates[0];
  const end = opts.end ?? dates[dates.length - 1];
  if (start === undefined || end === undefined) return []; // no data, no bounds

  const startMs = dayToUtc(start);
  const endMs = dayToUtc(end);
  if (endMs < startMs) return [];

  const ctlAlpha = 1 / ctlDays;
  const atlAlpha = 1 / atlDays;

  const out: TrainingLoadDay[] = [];
  let ctl = 0;
  let atl = 0;
  for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
    const date = utcToDay(ms);
    const load = loadByDate.get(date) ?? 0;
    // Form is read BEFORE today's session settles in (prev-day), or after
    // (same-day), per tsbMode.
    const prevCtl = ctl;
    const prevAtl = atl;
    ctl = ctl + ctlAlpha * (load - ctl);
    atl = atl + atlAlpha * (load - atl);
    const tsb = tsbMode === 'prev-day' ? prevCtl - prevAtl : ctl - atl;
    out.push({ date, load: round1(load), ctl: round1(ctl), atl: round1(atl), tsb: round1(tsb) });
  }
  return out;
}
