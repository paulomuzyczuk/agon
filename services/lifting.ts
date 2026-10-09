import { withTransaction } from './db';
import { computeBlockWeek } from '../lib/training/trainingBlocks';

// Persistence for a full lifting session at set-level granularity
// (lifting_sessions → lifting_exercises → lifting_sets). One transaction so a
// session is all-or-nothing: a half-written session would corrupt volume-load and
// e1RM analytics. exercise_order and set_number are assigned from array position
// (the capture layer preserves spoken order), satisfying the UNIQUE constraints.

export interface LiftingSetInput {
  reps: number | null;
  weightKg: number | null;
  rpe: number | null;
  restS: number | null;
  isWarmup: boolean;
  isFailure: boolean;
  notes: string | null;
}

export interface LiftingExerciseInput {
  exercise: string;
  notes: string | null;
  sets: LiftingSetInput[];
}

export interface LiftingSessionInput {
  date: string; // YYYY-MM-DD
  sessionType: string;
  durationMin: number | null;
  perceivedEffort: number | null;
  notes: string | null;
  source?: string; // defaults to 'telegram'
  exercises: LiftingExerciseInput[];
}

export interface LiftingInsertResult {
  sessionId: string;
  exerciseCount: number;
  setCount: number;
}

/** Insert a session and all its exercises/sets atomically; returns ids + counts. */
export async function insertLiftingSession(
  input: LiftingSessionInput,
): Promise<LiftingInsertResult> {
  const { block, week } = computeBlockWeek(input.date);
  return withTransaction(async (client) => {
    const session = await client.query<{ id: string }>(
      `INSERT INTO public.lifting_sessions
         (date, block, week, session_type, duration_min, perceived_effort, notes, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        input.date,
        block,
        week,
        input.sessionType,
        input.durationMin,
        input.perceivedEffort,
        input.notes,
        input.source ?? 'telegram',
      ],
    );
    const sessionId = session.rows[0]!.id;

    let setCount = 0;
    for (const [exIdx, ex] of input.exercises.entries()) {
      const exercise = await client.query<{ id: string }>(
        `INSERT INTO public.lifting_exercises
           (session_id, exercise, exercise_order, notes)
         VALUES ($1,$2,$3,$4)
         RETURNING id`,
        [sessionId, ex.exercise, exIdx, ex.notes],
      );
      const exerciseId = exercise.rows[0]!.id;

      for (const [setIdx, set] of ex.sets.entries()) {
        await client.query(
          `INSERT INTO public.lifting_sets
             (exercise_id, set_number, reps, weight_kg, rpe, rest_s,
              is_warmup, is_failure, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            exerciseId,
            setIdx + 1, // set_number is 1-based (CHECK set_number >= 1)
            set.reps,
            set.weightKg,
            set.rpe,
            set.restS,
            set.isWarmup,
            set.isFailure,
            set.notes,
          ],
        );
        setCount++;
      }
    }

    return { sessionId, exerciseCount: input.exercises.length, setCount };
  });
}
