import {
  resolveSession,
  adjustmentNote,
  type PlanFields,
  type AdjustmentFields,
  type ResolvedSession,
} from '../lib/training/sessionOverlay';

// The RESOLVED planned-session read (plan + session_adjustments overlay), as SQL
// fragments plus a pure row resolver. Deliberately imports no DB pool: the
// read-write app path (services/plannedSessions.ts → services/db.ts) and the
// read-only MCP layer (services/mcp/* → readQuery) both build on it, so the
// overlay rules live in exactly one place and the MCP never pulls in the
// writable pool (MZY-265).

/** The joined plan + adjustment columns every session read selects. */
export interface SessionRow {
  id: string;
  date: string;
  block: number | null;
  week: number | null;
  session_kind: 'run' | 'lift' | 'rest' | 'bike';
  status: string;
  description: string | null;
  target_distance_km: string | null;
  target_hr_cap: number | null;
  target_session_type: string | null;
  gcal_event_id: string | null;
  gcal_fueling_event_id: string | null;
  start_time: string | null;
  start_time_priority: 'strong' | 'suggested' | null;
  start_time_reason: string | null;
  adj_date: string | null;
  adj_description: string | null;
  adj_target_distance_km: string | null;
  adj_target_hr_cap: number | null;
  adj_target_session_type: string | null;
  adj_note: string | null;
  adj_detail: string | null;
}

/**
 * The SELECT list shared by the session reads: the program columns plus the
 * adjustment's overrides. `p` is planned_sessions, `a` the LEFT JOINed
 * session_adjustments. Callers filter and order on RESOLVED_DATE so a session
 * moved by an adjustment sorts and windows where the athlete actually put it,
 * not where the program did.
 */
export const SESSION_SELECT = `
  p.id, to_char(p.date, 'YYYY-MM-DD') AS date, p.block, p.week,
  p.session_kind, p.status, p.description, p.target_distance_km, p.target_hr_cap,
  p.target_session_type, p.gcal_event_id, p.gcal_fueling_event_id,
  to_char(p.start_time, 'HH24:MI') AS start_time,
  p.start_time_priority, p.start_time_reason,
  to_char(a.date, 'YYYY-MM-DD') AS adj_date,
  a.description             AS adj_description,
  a.target_distance_km      AS adj_target_distance_km,
  a.target_hr_cap           AS adj_target_hr_cap,
  a.target_session_type     AS adj_target_session_type,
  a.note                    AS adj_note,
  a.detail                  AS adj_detail`;

export const SESSION_FROM = `
  FROM public.planned_sessions p
  LEFT JOIN public.session_adjustments a
    ON a.planned_session_id = p.id AND a.deleted_at IS NULL`;

/** The date a session actually lands on: the adjustment's move, else the program's. */
export const RESOLVED_DATE = 'COALESCE(a.date, p.date)';

/** NUMERIC arrives from pg as a string; normalize to number|null. */
const num = (v: string | null): number | null =>
  v === null ? null : Number(v);

export interface ResolvedSessionRow {
  resolved: ResolvedSession;
  /** The 📝 deviation line (adjustmentNote), or null when it matches the program. */
  note: string | null;
}

/** Lay a joined row's adjustment over its plan. */
export function resolveSessionRow(r: SessionRow): ResolvedSessionRow {
  const plan: PlanFields = {
    date: r.date,
    block: r.block,
    week: r.week,
    description: r.description ?? '',
    targetDistanceKm: num(r.target_distance_km),
    targetHrCap: r.target_hr_cap,
    targetSessionType: r.target_session_type,
  };
  const hasAdjustment =
    r.adj_date !== null ||
    r.adj_description !== null ||
    r.adj_target_distance_km !== null ||
    r.adj_target_hr_cap !== null ||
    r.adj_target_session_type !== null ||
    r.adj_note !== null ||
    r.adj_detail !== null;
  const adjustment: AdjustmentFields | null = hasAdjustment
    ? {
        date: r.adj_date,
        description: r.adj_description,
        targetDistanceKm: num(r.adj_target_distance_km),
        targetHrCap: r.adj_target_hr_cap,
        targetSessionType: r.adj_target_session_type,
        note: r.adj_note,
        detail: r.adj_detail,
      }
    : null;
  const resolved = resolveSession(plan, adjustment);
  return { resolved, note: adjustmentNote(resolved) };
}
