import { getAthleteProfile } from '../athleteProfile';
import { computeBlockWeek } from './trainingBlocks';

// Executable encoding of the training program in
// docs/training-program.local.md (each self-hoster's own program, gitignored —
// docs/training-program.example.md is the committed template) — the structured
// twin of that document's weekly-template + weekly-volume tables, and the
// source the seed script (scripts/seed-planned-sessions.ts) expands into
// `planned_sessions` rows. Keep this file and the doc in sync: the doc is the
// human source of truth, this is what the machine reads. Block/week stamping
// and the program calendar come from ./trainingBlocks.ts +
// lib/athleteProfile.ts, so there is one anchor date and one week-bucketing
// rule across the codebase.
//
// This file itself — the block templates and weekly volume targets below — is
// deliberately NOT templatized into config/JSON. It's the "essential
// complexity" of a specific training program (CLAUDE.md's self-hosting
// decision, wiki/topics/sre-simplicity.md): every athlete's program differs
// in ways a generic schema can't capture without becoming a full DSL (already
// backlogged separately in CLAUDE.md as future work, not built here). A
// self-hoster running their OWN program edits BLOCK_1/BLOCK_2/BLOCK_3 (and the
// programBlockCount/programWeeksPerBlock fields in their
// config/athlete-profile.local.json) directly, using
// docs/training-program.example.md as the template for documenting it.

/** Weekday offset within a Monday-aligned program week: Mon=0 … Sun=6. */
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type SessionKind = 'run' | 'lift' | 'rest' | 'bike';

/**
 * `target_session_type` vocabulary. Runs: intensity/kind. Lifts: the session
 * label for the block's split (A/B/C full-body, upper/lower, push/pull/legs).
 */
export type SessionType =
  | 'easy'
  | 'long'
  | 'tempo'
  | 'intervals'
  | 'vo2max'
  | 'A'
  | 'B'
  | 'C'
  | 'upper'
  | 'lower'
  | 'push'
  | 'pull'
  | 'legs';

/** One session in a block's weekly template. A day may hold a run and a lift. */
interface TemplateSlot {
  weekday: Weekday;
  kind: SessionKind;
  description: string;
  /** null for rest. */
  type: SessionType | null;
  /** Base weekly distance for a run; scaled to the week's volume target. null for lift/rest. */
  baseKm: number | null;
  /** Easy-run HR ceiling. null for quality runs (no cap) and lift/rest. */
  hrCap: number | null;
}

interface BlockPlan {
  /** 1-based block number. */
  block: number;
  template: TemplateSlot[];
  /** Weekly distance target (km) for each of the block's 8 weeks, incl. deloads. */
  weeklyVolumeKm: number[];
}

const REST: Omit<TemplateSlot, 'weekday'> = {
  kind: 'rest',
  description: 'Rest',
  type: null,
  baseKm: null,
  hrCap: null,
};

// Block 1 — Weeks 1–8. Rebuild foundation. 4 easy runs + 3 full-body lifts
// (A/B/C). Easy-run HR cap 154. Rest Monday; double day Tue (easy run + Lift A).
const BLOCK_1: BlockPlan = {
  block: 1,
  template: [
    { weekday: 0, ...REST },
    { weekday: 1, kind: 'run', description: 'Easy run', type: 'easy', baseKm: 8, hrCap: 154 },
    { weekday: 1, kind: 'lift', description: 'Lift A — full body', type: 'A', baseKm: null, hrCap: null },
    { weekday: 2, kind: 'run', description: 'Easy run', type: 'easy', baseKm: 7, hrCap: 154 },
    { weekday: 3, kind: 'lift', description: 'Lift B — full body', type: 'B', baseKm: null, hrCap: null },
    { weekday: 4, kind: 'run', description: 'Easy run', type: 'easy', baseKm: 8, hrCap: 154 },
    { weekday: 5, kind: 'run', description: 'Long easy run', type: 'long', baseKm: 11, hrCap: 154 },
    { weekday: 6, kind: 'lift', description: 'Lift C — full body', type: 'C', baseKm: null, hrCap: null },
  ],
  weeklyVolumeKm: [32, 34, 35, 30, 34, 35, 35, 31],
};

// Block 2 — Weeks 9–16. Build intensity, introduce tempo. 5 runs (incl. 4×1200 m
// tempo) + 3 lifts (Upper/Lower, 3-day rotation). Rest Monday; double days Wed +
// Sun.
const BLOCK_2: BlockPlan = {
  block: 2,
  template: [
    { weekday: 0, ...REST },
    { weekday: 1, kind: 'run', description: 'Tempo — 4×1200 m', type: 'intervals', baseKm: 9, hrCap: null },
    { weekday: 2, kind: 'run', description: 'Easy run', type: 'easy', baseKm: 7, hrCap: 156 },
    { weekday: 2, kind: 'lift', description: 'Lift — Upper', type: 'upper', baseKm: null, hrCap: null },
    { weekday: 3, kind: 'run', description: 'Easy run', type: 'easy', baseKm: 8, hrCap: 156 },
    { weekday: 4, kind: 'lift', description: 'Lift — Lower', type: 'lower', baseKm: null, hrCap: null },
    { weekday: 5, kind: 'run', description: 'Long easy run', type: 'long', baseKm: 14, hrCap: 158 },
    { weekday: 6, kind: 'run', description: 'Recovery easy run', type: 'easy', baseKm: 6, hrCap: 150 },
    { weekday: 6, kind: 'lift', description: 'Lift — Upper/Lower (rotating)', type: 'upper', baseKm: null, hrCap: null },
  ],
  weeklyVolumeKm: [38, 40, 42, 34, 40, 41, 42, 36],
};

// Block 3 — Weeks 17–24. Peak running. 4 runs (incl. VO2max/tempo Tue) + 3 lifts
// (Push/Pull/Legs). Rest Monday; double day Wed (easy run + Push). Every Tuesday
// is tagged vo2max as a simplification (true VO2max cadence is every 10–14 days).
const BLOCK_3: BlockPlan = {
  block: 3,
  template: [
    { weekday: 0, ...REST },
    { weekday: 1, kind: 'run', description: 'Quality — VO2max / tempo', type: 'vo2max', baseKm: 10, hrCap: null },
    { weekday: 2, kind: 'run', description: 'Easy run', type: 'easy', baseKm: 8, hrCap: 156 },
    { weekday: 2, kind: 'lift', description: 'Lift — Push', type: 'push', baseKm: null, hrCap: null },
    { weekday: 3, kind: 'lift', description: 'Lift — Pull', type: 'pull', baseKm: null, hrCap: null },
    { weekday: 4, kind: 'run', description: 'Easy run', type: 'easy', baseKm: 8, hrCap: 156 },
    { weekday: 5, kind: 'run', description: 'Long run', type: 'long', baseKm: 19, hrCap: 158 },
    { weekday: 6, kind: 'lift', description: 'Lift — Legs', type: 'legs', baseKm: null, hrCap: null },
  ],
  weeklyVolumeKm: [42, 45, 48, 40, 44, 46, 48, 40],
};

const BLOCKS: BlockPlan[] = [BLOCK_1, BLOCK_2, BLOCK_3];

/** A single planned session ready to upsert into `planned_sessions`. */
export interface PlannedSessionSpec {
  /** Deterministic idempotency key: "<date>:<kind>" (see the plan_key migration). */
  planKey: string;
  dateISO: string;
  block: number | null;
  week: number | null;
  sessionKind: SessionKind;
  description: string;
  targetDistanceKm: number | null;
  targetHrCap: number | null;
  targetSessionType: SessionType | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `startISO` + `n` days as YYYY-MM-DD, via UTC midnight to avoid DST drift. */
function addDaysISO(startISO: string, n: number): string {
  const start = Date.parse(`${startISO}T00:00:00Z`);
  if (Number.isNaN(start)) {
    throw new Error(`trainingProgram: invalid start date ${startISO}`);
  }
  return new Date(start + n * MS_PER_DAY).toISOString().slice(0, 10);
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * Expand the whole program into one PlannedSessionSpec per session, across all
 * blocks × 8 weeks, dated from the program start. Run distances scale each week
 * to that week's volume target (a run's base km × weekTarget / templateBaseWeek);
 * lifts and rest carry no distance. Pure — no DB, no clock — so it's unit-tested
 * directly and the seed script only handles persistence.
 */
export function expandProgram(
  startISO: string = getAthleteProfile().trainingStartDate,
): PlannedSessionSpec[] {
  const { programWeeksPerBlock } = getAthleteProfile();
  const specs: PlannedSessionSpec[] = [];

  for (let blockIndex = 0; blockIndex < BLOCKS.length; blockIndex++) {
    const plan = BLOCKS[blockIndex]!;
    const baseWeekKm = plan.template.reduce(
      (sum, slot) => sum + (slot.kind === 'run' ? slot.baseKm ?? 0 : 0),
      0,
    );

    for (let weekIndex = 0; weekIndex < programWeeksPerBlock; weekIndex++) {
      const weekTargetKm = plan.weeklyVolumeKm[weekIndex]!;
      const scale = weekTargetKm / baseWeekKm;
      const globalWeek = blockIndex * programWeeksPerBlock + weekIndex;

      for (const slot of plan.template) {
        const dateISO = addDaysISO(startISO, globalWeek * 7 + slot.weekday);
        const { block, week } = computeBlockWeek(dateISO, startISO);
        const targetDistanceKm =
          slot.kind === 'run' && slot.baseKm !== null
            ? round1(slot.baseKm * scale)
            : null;

        specs.push({
          planKey: `${dateISO}:${slot.kind}`,
          dateISO,
          block,
          week,
          sessionKind: slot.kind,
          description: slot.description,
          targetDistanceKm,
          targetHrCap: slot.hrCap,
          targetSessionType: slot.type,
        });
      }
    }
  }

  return specs;
}

/** Total sessions the program expands to — handy for the seed script's log. */
export const PROGRAM_SESSION_COUNT =
  (BLOCK_1.template.length + BLOCK_2.template.length + BLOCK_3.template.length) *
  getAthleteProfile().programWeeksPerBlock;

/** Guard against the block table drifting from the declared program length. */
if (BLOCKS.length !== getAthleteProfile().programBlockCount) {
  throw new Error(
    `trainingProgram: ${BLOCKS.length} blocks defined but programBlockCount=${getAthleteProfile().programBlockCount} (config/athlete-profile.local.json)`,
  );
}
