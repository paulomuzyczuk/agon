import { getAthleteProfile } from '../athleteProfile';

// Derives program block + week from a calendar date. Weeks are Monday-aligned
// 7-day buckets counted from the athlete's trainingStartDate (itself a Monday),
// matching how the program in /docs/training-program.local.md is structured.
// This is the single source of truth for stamping `runs.block` / `runs.week`
// at ingest time and (later) for plan-vs-actual compliance.

export interface BlockWeek {
  /** 1-based program block (1..programBlockCount), or null before the program starts. */
  block: number | null;
  /** 1-based program week, or null before the program starts. */
  week: number | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Days from `startISO` (inclusive) to `dateISO`, using UTC midnight to avoid DST drift. */
function dayDelta(startISO: string, dateISO: string): number {
  const start = Date.parse(`${startISO}T00:00:00Z`);
  const date = Date.parse(`${dateISO}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(date)) {
    throw new Error(
      `trainingBlocks: invalid date input (start=${startISO}, date=${dateISO})`,
    );
  }
  return Math.floor((date - start) / MS_PER_DAY);
}

/**
 * @param dateISO calendar date as `YYYY-MM-DD` (a run's local start date).
 * @param startISO override the program start (defaults to the athlete profile's
 *   trainingStartDate). Weeks/blocks past the programmed length keep counting
 *   linearly — the program may be extended; a later date isn't clamped.
 */
export function computeBlockWeek(
  dateISO: string,
  startISO: string = getAthleteProfile().trainingStartDate,
): BlockWeek {
  const { programWeeksPerBlock, programBlockCount } = getAthleteProfile();
  const days = dayDelta(startISO, dateISO);
  if (days < 0) return { block: null, week: null }; // pre-program (e.g. baseline runs)
  const week = Math.floor(days / 7) + 1;
  const block = Math.floor((week - 1) / programWeeksPerBlock) + 1;
  // Clamp only the *reported* block to the known program length; week keeps
  // counting so an over-run program still logs a monotonic week number.
  return { block: Math.min(block, programBlockCount), week };
}

/**
 * True when `week` lies past the blocks computeBlockWeek models
 * (programWeeksPerBlock × programBlockCount) — its block there is a clamp, not
 * a real block (e.g. an extra hand-specified block beyond the template).
 */
export function isBeyondModelledBlocks(week: number | null): boolean {
  if (week === null) return false;
  const { programWeeksPerBlock, programBlockCount } = getAthleteProfile();
  return week > programWeeksPerBlock * programBlockCount;
}

export interface DateRange {
  start: string; // inclusive YYYY-MM-DD (a Monday)
  end: string; // inclusive YYYY-MM-DD (the Sunday)
}

/**
 * The Monday–Sunday calendar range of the program week containing `dateISO`, or
 * null before the program starts. Used by the `/week` summary to count the
 * week's runs/lifts. Same Monday-aligned bucketing as computeBlockWeek.
 */
export function programWeekRange(
  dateISO: string,
  startISO: string = getAthleteProfile().trainingStartDate,
): DateRange | null {
  const days = dayDelta(startISO, dateISO);
  if (days < 0) return null;
  const weekIndex = Math.floor(days / 7);
  const startMs =
    Date.parse(`${startISO}T00:00:00Z`) + weekIndex * 7 * MS_PER_DAY;
  return {
    start: new Date(startMs).toISOString().slice(0, 10),
    end: new Date(startMs + 6 * MS_PER_DAY).toISOString().slice(0, 10),
  };
}
