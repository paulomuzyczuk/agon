// Per-session workout detail for calendar event descriptions: the exercises
// (sets × reps) for each lift session, and the interval structure for quality
// runs. Keyed on planned_sessions.target_session_type — each lift type belongs to
// exactly one block (A/B/C = Block 1 full-body, upper/lower = Block 2, push/pull/
// legs = Block 3), so the type alone identifies the session.
//
// DRAFT content (2026-07-30), mirrored in docs/training-program.local.md for review.
// planned_sessions stays a lean schedule; this static library supplies the detail
// so the schema doesn't need per-exercise planned rows (those tables hold REALIZED
// sets). Edit here + in the doc, then re-run `pnpm gcal:sync` to update events.

export interface LiftExercise {
  exercise: string;
  scheme: string; // sets × reps, e.g. "4×6–8"
}

// Block 1 (full body A/B/C), Block 2 (Upper/Lower), Block 3 (Push/Pull/Legs).
const LIFT_SESSIONS: Record<string, LiftExercise[]> = {
  // Block 1 — relearn the lifts, moderate volume.
  A: [
    { exercise: 'Back squat', scheme: '3×5' },
    { exercise: 'Bench press', scheme: '3×5' },
    { exercise: 'Barbell row', scheme: '3×8' },
    { exercise: 'Overhead press', scheme: '3×8' },
    { exercise: 'Plank', scheme: '3×45s' },
  ],
  B: [
    { exercise: 'Deadlift', scheme: '3×5' },
    { exercise: 'Overhead press', scheme: '3×5' },
    { exercise: 'Lat pulldown', scheme: '3×10' },
    { exercise: 'Dumbbell lunge', scheme: '3×10' },
    { exercise: 'Hanging leg raise', scheme: '3×12' },
  ],
  C: [
    { exercise: 'Front squat', scheme: '3×6' },
    { exercise: 'Incline dumbbell press', scheme: '3×8' },
    { exercise: 'Pull-up', scheme: '3×AMRAP' },
    { exercise: 'Romanian deadlift', scheme: '3×8' },
    { exercise: 'Cable crunch', scheme: '3×15' },
  ],
  // Block 2 — Upper/Lower, 4×6–8, RPE 7–8.
  upper: [
    { exercise: 'Bench press', scheme: '4×6–8' },
    { exercise: 'Weighted pull-up', scheme: '4×6–8' },
    { exercise: 'Overhead press', scheme: '4×8' },
    { exercise: 'Barbell row', scheme: '4×8' },
    { exercise: 'Lateral raise', scheme: '3×12' },
    { exercise: 'Barbell curl', scheme: '3×10' },
  ],
  lower: [
    { exercise: 'Back squat', scheme: '4×6–8' },
    { exercise: 'Romanian deadlift', scheme: '4×8' },
    { exercise: 'Bulgarian split squat', scheme: '3×10' },
    { exercise: 'Leg curl', scheme: '3×12' },
    { exercise: 'Standing calf raise', scheme: '4×12' },
    { exercise: 'Hanging leg raise', scheme: '3×15' },
  ],
  // Block 3 — Push/Pull/Legs, volume down, intensity maintained.
  push: [
    { exercise: 'Bench press', scheme: '5×5' },
    { exercise: 'Overhead press', scheme: '4×6' },
    { exercise: 'Incline dumbbell press', scheme: '3×8' },
    { exercise: 'Dips', scheme: '3×8' },
    { exercise: 'Lateral raise', scheme: '3×12' },
    { exercise: 'Triceps pushdown', scheme: '3×12' },
  ],
  pull: [
    { exercise: 'Deadlift', scheme: '4×4' },
    { exercise: 'Weighted pull-up', scheme: '4×6' },
    { exercise: 'Barbell row', scheme: '4×8' },
    { exercise: 'Face pull', scheme: '3×15' },
    { exercise: 'Barbell curl', scheme: '3×10' },
    { exercise: 'Hammer curl', scheme: '3×12' },
  ],
  legs: [
    { exercise: 'Back squat', scheme: '5×5' },
    { exercise: 'Romanian deadlift', scheme: '4×6' },
    { exercise: 'Leg press', scheme: '3×10' },
    { exercise: 'Leg curl', scheme: '3×12' },
    { exercise: 'Standing calf raise', scheme: '4×15' },
    { exercise: 'Hanging leg raise', scheme: '3×15' },
  ],
};

// Quality-run structure lines (warm-up / main set / cool-down). Easy & long runs
// have no structured detail (null) — the target distance + HR cap say it all.
//
// Recovery convention (decision 2026-08-27, locked): all interval-session recovery
// segments are prescribed as a DISTANCE (jog N m), never a duration — easier for the
// athlete to control live off pace/distance on a watch than a self-timed rest clock.
// Distances below convert the prior time-based recovery (90 s / 2:30) at an assumed
// ~6:30/km easy jog pace, rounded to a clean number. Any future interval/VO2max
// entry added here must follow the same distance-based recovery convention.
const QUALITY_RUNS: Record<string, string[]> = {
  intervals: [
    // Block 2 tempo — 4×1200 m, progressing toward continuous.
    'Warm-up: 2 km easy',
    'Main: 4×1200 m @ threshold (10K pace), 200 m jog recovery',
    'Cool-down: 2 km easy',
  ],
  vo2max: [
    // Block 3 quality — VO2max intervals (tempo on the off weeks).
    'Warm-up: 2 km easy',
    'Main: 5×1000 m @ 5K pace, 400 m jog recovery',
    'Cool-down: 2 km easy',
  ],
};

/** Exercises for a lift session type, or null if the type isn't a known lift. */
export function getLiftDetail(sessionType: string | null): LiftExercise[] | null {
  if (!sessionType) return null;
  return LIFT_SESSIONS[sessionType] ?? null;
}

/** Interval structure lines for a quality run type, or null for easy/long runs. */
export function getRunDetail(sessionType: string | null): string[] | null {
  if (!sessionType) return null;
  return QUALITY_RUNS[sessionType] ?? null;
}
