// Pure e1RM (estimated one-rep max) + volume-load math, DB-free + unit-tested.
// Feeds the future `fct_lift_progression` dbt mart (per exercise, per block:
// best e1RM + total volume-load) — see CLAUDE.md Phase 3. Not yet wired to a
// mart/PWA view: `lifting_sets` has 0 rows in the live DB (Telegram lift
// capture is built but unused so far), so there's nothing real to chart.
// Landing the formulas now means the mart is a pure SQL/read exercise once
// there's data, not a from-scratch design.
//
// Two classic formulas, both widely used in strength-tracking tools (credit:
// formulas only, no code — see CLAUDE.md "Prior Art & Attribution"):
//   Epley:   1RM = weight × (1 + reps/30)            — valid for any reps > 0
//   Brzycki: 1RM = weight × 36 / (37 − reps)          — undefined at reps >= 37
// Epley is the headline (simpler, doesn't blow up at high reps); Brzycki is
// reported alongside as a cross-check, same "headline + cross-check" pattern
// as lib/racePrediction.ts (Riegel headline, VDOT cross-check).

export interface E1RMEstimate {
  /** Epley estimate — the headline number. */
  epley: number;
  /** Brzycki estimate, or null when reps >= 37 (the formula is undefined there). */
  brzycki: number | null;
}

/** Estimated 1RM for one set. Returns null for non-positive weight/reps. */
export function estimate1RM(weightKg: number, reps: number): E1RMEstimate | null {
  if (!(weightKg > 0) || !(reps > 0)) return null;
  const epley = weightKg * (1 + reps / 30);
  const brzycki = reps < 37 ? (weightKg * 36) / (37 - reps) : null;
  return { epley, brzycki };
}

/** Volume-load (weight × reps) for one set. */
export function volumeLoad(weightKg: number, reps: number): number {
  if (!(weightKg > 0) || !(reps > 0)) return 0;
  return weightKg * reps;
}

export interface WorkingSet {
  weightKg: number;
  reps: number;
  /** Warmup sets don't count toward volume-load or the best-e1RM search. */
  isWarmup?: boolean;
}

/** Sum of volume-load across a session/exercise's working sets (warmups excluded). */
export function totalVolumeLoad(sets: WorkingSet[]): number {
  return sets
    .filter((s) => !s.isWarmup)
    .reduce((sum, s) => sum + volumeLoad(s.weightKg, s.reps), 0);
}

/**
 * Best (highest) Epley e1RM across a session/exercise's working sets.
 * Returns null when there are no valid working sets.
 */
export function bestE1RM(sets: WorkingSet[]): number | null {
  const estimates = sets
    .filter((s) => !s.isWarmup)
    .map((s) => estimate1RM(s.weightKg, s.reps))
    .filter((e): e is E1RMEstimate => e != null);
  if (estimates.length === 0) return null;
  return Math.max(...estimates.map((e) => e.epley));
}
