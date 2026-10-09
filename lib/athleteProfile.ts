import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';

// Loads the athlete's personal profile numbers (time zone, program anchor
// dates/lengths, HR/sweat/body-composition anchors) from a PRIVATE config file —
// never hardcoded in this repo (self-hosting decision — see CLAUDE.md "Config/
// secrets templating"). These used to be plain exported constants in
// lib/constants.ts; every self-hoster runs their own program with their own
// numbers, which is exactly "configuration, not code" (Thomas & Hunt Ch.5).
//
// Path resolution mirrors scripts/seed-nutrition-goals.ts's
// AGON_NUTRITION_GOALS_PATH pattern exactly: AGON_ATHLETE_PROFILE_PATH if set,
// else config/athlete-profile.local.json (gitignored via config/*.local.json in
// .gitignore — no changes needed there). Loaded lazily and memoized: importing
// this module never touches the filesystem, only calling getAthleteProfile()
// does, so a bare `tsc`/test-import of a module that merely re-exports a
// default parameter never fails just because the config file isn't there yet —
// but any code path that actually NEEDS a real value fails loudly with an
// explicit "copy the .example.json and fill in real values" error, never a
// silent guess (same rationale as the nutrition-goals loader).

const AthleteProfileSchema = z.object({
  /** IANA time zone (e.g. "Europe/Berlin"). Used to resolve "today"/local dates. */
  timeZone: z.string().min(1),
  /** Program week 1 start date (a Monday), YYYY-MM-DD. */
  trainingStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Weeks per training block (e.g. 8). */
  programWeeksPerBlock: z.number().int().positive(),
  /** Number of training blocks in the program (e.g. 3). */
  programBlockCount: z.number().int().positive(),
  /** Measured max HR (bpm), used by the Banister TRIMP / Relative Effort model. */
  hrMax: z.number().int().positive(),
  /** Resting HR (bpm) — prefer a daily-RHR device average over a spot reading. */
  hrRest: z.number().int().positive(),
  /** Measured baseline sweat rate (L/h) for the fueling/hydration model. */
  sweatRateBaselineLPerH: z.number().positive(),
  /** Sweat sodium concentration (mg/L) — population-average default, ~450-1,600 typical range. */
  sweatSodiumMgPerL: z.number().positive(),
  /** Assumed sweat rate (L/h) for lift sessions (lower intensity/indoor than running). */
  liftSweatRateLPerH: z.number().positive(),
  /** Fallback body weight (kg) for macro-target math when no weigh-in is logged yet. */
  weightKgFallback: z.number().positive(),
  /** Body weight (kg) at training start — a fixed historical reference line, never recalibrated. */
  startingWeightKg: z.number().positive(),
  /** Body fat % at training start — same fixed-reference reasoning as startingWeightKg. */
  startingBodyFatPct: z.number().positive(),
  /**
   * Functional Threshold Power history (MZY-269), optional: each entry is an
   * FTP test or estimate and holds from its date until the next one. Only
   * needed with a power meter — without it IF/TSS stay null (NP and the
   * power curve need no anchor).
   */
  ftpHistory: z
    .array(
      z.object({
        watts: z.number().int().min(50).max(1000),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
    .optional(),
  /**
   * Measured or device-estimated VO2max (ml/kg/min), optional: a ceiling the
   * race-prediction report contrasts the effort-derived VDOT against.
   */
  vo2maxMeasured: z.number().min(20).max(100).optional(),
});

export type AthleteProfile = z.infer<typeof AthleteProfileSchema>;
export type FtpEntry = NonNullable<AthleteProfile['ftpHistory']>[number];

/**
 * The FTP entry in force on `date` (YYYY-MM-DD): the latest one dated on or
 * before it, or null when there is none. Does not trust the config file's
 * order. Pure, so callers pass the history in.
 */
export function ftpEntryOn(
  date: string,
  history: readonly FtpEntry[] | undefined,
): FtpEntry | null {
  let best: FtpEntry | null = null;
  for (const e of history ?? []) {
    if (e.date <= date && (best === null || e.date >= best.date)) best = e;
  }
  return best;
}

/** The FTP (W) in force on `date`, or null — see ftpEntryOn. */
export function ftpOn(
  date: string,
  history: readonly FtpEntry[] | undefined,
): number | null {
  return ftpEntryOn(date, history)?.watts ?? null;
}

function resolveProfilePath(): string {
  return (
    process.env.AGON_ATHLETE_PROFILE_PATH ||
    resolve(process.cwd(), 'config/athlete-profile.local.json')
  );
}

let cached: AthleteProfile | null = null;

/**
 * Returns the athlete's profile, reading + validating the config file on first
 * call and caching the result. Throws if the file is missing or malformed —
 * this is per-installer configuration the app cannot function without, so a
 * missing file must fail loudly, not silently fall back to someone else's numbers.
 */
export function getAthleteProfile(): AthleteProfile {
  if (cached) return cached;

  const path = resolveProfilePath();
  if (!existsSync(path)) {
    throw new Error(
      `athleteProfile: no profile file at ${path}. Copy ` +
        `config/athlete-profile.example.json there (or point ` +
        `AGON_ATHLETE_PROFILE_PATH at your own private copy) and fill in your real values.`,
    );
  }

  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  cached = AthleteProfileSchema.parse(raw);
  return cached;
}

/** Test-only: clear the memoized profile so a test can point at a different file. */
export function _resetAthleteProfileCacheForTests(): void {
  cached = null;
}
