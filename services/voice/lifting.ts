import { insertLiftingSession } from '../lifting';
import type { LiftingParse } from './schemas';

// Fan a parsed lifting note out into the normalized set-level tables. Reps /
// duration / rest arrive as numbers from the model; round to the integers the
// columns expect. Order is preserved from the arrays (insertLiftingSession
// assigns exercise_order / set_number from position).

const toInt = (n: number | null): number | null =>
  n == null ? null : Math.round(n);

export interface LiftingFanOutResult {
  sessionId: string;
  exerciseCount: number;
  setCount: number;
}

export async function fanOutLifting(
  parse: LiftingParse,
  effectiveDate: string,
): Promise<LiftingFanOutResult> {
  const result = await insertLiftingSession({
    date: effectiveDate,
    sessionType: parse.session_type,
    durationMin: toInt(parse.duration_min),
    perceivedEffort: parse.perceived_effort,
    notes: parse.notes,
    exercises: parse.exercises.map((ex) => ({
      exercise: ex.exercise,
      notes: ex.notes,
      sets: ex.sets.map((s) => ({
        reps: toInt(s.reps),
        weightKg: s.weight_kg,
        rpe: s.rpe,
        restS: toInt(s.rest_s),
        isWarmup: s.is_warmup,
        isFailure: s.is_failure,
        notes: s.notes,
      })),
    })),
  });
  return result;
}
