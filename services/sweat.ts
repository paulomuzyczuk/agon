import { query } from './db';
import { getAthleteProfile } from '../lib/athleteProfile';
import { sweatRateLPerH } from '../lib/sweat';

// Persistence for /sweat weigh-in observations, and the current baseline the
// fueling model reads. Each observation is attributed to the latest run on its
// date (for the duration to divide by) and stores the derived L/h rate. The
// "current baseline" is the most recent observation's rate, falling back to the
// measured profile baseline when no observation has a computed rate yet.

export interface RunForSweat {
  id: string;
  durationS: number;
}

/** Latest run on a date, with its duration — the effort a weigh-in divides by. */
export async function findLatestRunForSweat(
  date: string,
): Promise<RunForSweat | null> {
  const { rows } = await query<{ id: string; duration_s: number }>(
    `SELECT id, duration_s
       FROM public.runs
      WHERE date = $1
      ORDER BY started_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [date],
  );
  const row = rows[0];
  return row ? { id: row.id, durationS: row.duration_s } : null;
}

export interface SweatObservationInput {
  date: string; // YYYY-MM-DD
  preKg: number;
  postKg: number;
  fluidL: number;
  notes?: string | null;
}

export interface SweatObservationResult {
  id: string;
  sweatRateLPerH: number | null;
  durationS: number | null;
  runId: string | null;
}

/**
 * Record a weigh-in observation. Attributes it to the latest run on its date to
 * get a duration, derives the L/h rate, and persists both. Returns the derived
 * rate (null when there was no run to divide by).
 */
export async function recordSweatObservation(
  input: SweatObservationInput,
): Promise<SweatObservationResult> {
  const run = await findLatestRunForSweat(input.date);
  const durationS = run?.durationS ?? null;
  const rate = sweatRateLPerH({
    preKg: input.preKg,
    postKg: input.postKg,
    fluidL: input.fluidL,
    durationS,
  });

  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.sweat_observations
       (date, pre_kg, post_kg, fluid_l, duration_s, run_id, sweat_rate_l_per_h, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      input.date,
      input.preKg,
      input.postKg,
      input.fluidL,
      durationS,
      run?.id ?? null,
      rate,
      input.notes ?? null,
    ],
  );

  return {
    id: rows[0]!.id,
    sweatRateLPerH: rate,
    durationS,
    runId: run?.id ?? null,
  };
}

/**
 * Current baseline sweat rate (L/h): the most recent observation that produced a
 * rate, else the measured profile baseline. This is what the fueling model reads.
 */
export async function getBaselineSweatRate(): Promise<number> {
  const { rows } = await query<{ sweat_rate_l_per_h: string }>(
    `SELECT sweat_rate_l_per_h
       FROM public.sweat_observations
      WHERE sweat_rate_l_per_h IS NOT NULL
      ORDER BY date DESC, created_at DESC
      LIMIT 1`,
  );
  const row = rows[0];
  return row ? Number(row.sweat_rate_l_per_h) : getAthleteProfile().sweatRateBaselineLPerH;
}
