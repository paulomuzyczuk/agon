import { computeBlockWeek, isBeyondModelledBlocks } from './trainingBlocks';

// Resolving a planned session against its adjustment (CLAUDE.md: plan vs reality).
//
// The program is seeded from docs/training-program.local.md and must stay exactly as
// authored; what the athlete actually does is recorded separately in
// session_adjustments. Everything that reads a session for display — above all the
// Google Calendar sync — reads the RESOLVED view: the plan with the adjustment's
// non-null fields laid over it.
//
// Pure by design (no DB, no Date.now) so the precedence rules are unit-tested
// directly and the service layer only moves rows.

/** The program's own record of a session. Mirrors the planned_sessions columns. */
export interface PlanFields {
  date: string; // YYYY-MM-DD
  block: number | null;
  week: number | null;
  description: string;
  targetDistanceKm: number | null;
  targetHrCap: number | null;
  targetSessionType: string | null;
}

/** A deviation from the program. Every field is optional: null means "unadjusted". */
export interface AdjustmentFields {
  date?: string | null;
  description?: string | null;
  targetDistanceKm?: number | null;
  targetHrCap?: number | null;
  targetSessionType?: string | null;
  note?: string | null;
  /**
   * The athlete's own detail lines (a lift's exercises, a ride's notes), read
   * back from a hand-edited calendar event (MZY-262). Newline-joined, safe HTML.
   */
  detail?: string | null;
}

export interface ResolvedSession extends PlanFields {
  /** True when any field came from the adjustment rather than the plan. */
  adjusted: boolean;
  /** The adjustment's note, when it has one — surfaced in the calendar event. */
  note: string | null;
  /** The program's original date, when the adjustment moved it. */
  originalDate: string | null;
  /** The athlete's detail override, or null to render the program's detail. */
  detail: string | null;
}

/** `undefined` and `null` both mean "no override"; 0 and '' are real values. */
function override<T>(planValue: T, adjustmentValue: T | null | undefined): T {
  return adjustmentValue === null || adjustmentValue === undefined
    ? planValue
    : adjustmentValue;
}

/**
 * Lay an adjustment over a plan. A null adjustment resolves to the plan itself.
 *
 * Moving the date RECOMPUTES block/week rather than carrying the program's: a
 * session dragged into the next week belongs to that week for load accounting,
 * and leaving the old stamp would quietly corrupt every per-week rollup.
 */
export function resolveSession(
  plan: PlanFields,
  adjustment: AdjustmentFields | null,
): ResolvedSession {
  if (!adjustment) {
    return {
      ...plan,
      adjusted: false,
      note: null,
      originalDate: null,
      detail: null,
    };
  }

  const date = override(plan.date, adjustment.date);
  const moved = date !== plan.date;
  // Recompute only when the date actually moved, so a session the program left
  // unstamped (block/week null, e.g. a pre-program baseline) stays unstamped.
  const computed = moved ? computeBlockWeek(date) : null;
  const week = computed ? computed.week : plan.week;
  // The block, though, keeps the program's stamp when the move stays inside the
  // same week, or lands where computeBlockWeek only clamps (past its modelled
  // blocks) — otherwise a moved Block 4 session reads "Block 3" (MZY-259).
  const block =
    computed &&
    computed.week !== plan.week &&
    !isBeyondModelledBlocks(computed.week)
      ? computed.block
      : plan.block;

  const resolved: ResolvedSession = {
    date,
    block,
    week,
    description: override(plan.description, adjustment.description),
    targetDistanceKm: override(
      plan.targetDistanceKm,
      adjustment.targetDistanceKm,
    ),
    targetHrCap: override(plan.targetHrCap, adjustment.targetHrCap),
    targetSessionType: override(
      plan.targetSessionType,
      adjustment.targetSessionType,
    ),
    adjusted: false,
    note: adjustment.note ?? null,
    originalDate: moved ? plan.date : null,
    detail: adjustment.detail ?? null,
  };

  resolved.adjusted =
    moved ||
    resolved.description !== plan.description ||
    resolved.targetDistanceKm !== plan.targetDistanceKm ||
    resolved.targetHrCap !== plan.targetHrCap ||
    resolved.targetSessionType !== plan.targetSessionType ||
    resolved.note !== null ||
    resolved.detail !== null;

  return resolved;
}

/**
 * The line explaining a deviation, for the calendar event description, or null
 * when the session matches the program. A moved session always says where it came
 * from — finding a run on a different day with no explanation is exactly the
 * confusion this layer exists to prevent.
 */
export function adjustmentNote(resolved: ResolvedSession): string | null {
  if (!resolved.adjusted) return null;
  const parts: string[] = [];
  if (resolved.originalDate) parts.push(`moved from ${resolved.originalDate}`);
  if (resolved.note) parts.push(resolved.note);
  if (parts.length === 0) return '📝 Adjusted from the plan';
  return `📝 ${parts.join(' — ')}`;
}
