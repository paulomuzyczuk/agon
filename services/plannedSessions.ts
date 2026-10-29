import { query } from './db';
import type { PlannedSessionSpec } from '../lib/training/trainingProgram';
import type { PlannedSessionForEvent } from './googleCalendar/eventMap';
import type { PushedEvent } from '../lib/calendarReconcile';
import type { EventResource } from './googleCalendar/types';
import {
  SESSION_SELECT,
  SESSION_FROM,
  resolveSessionRow,
  type SessionRow,
} from './plannedSessionView';

// planned_sessions writer. Rows are seeded from the training program
// (lib/training/trainingProgram.ts, docs/training-program.local.md) and later read by the
// Google Calendar sync and plan-vs-actual compliance marts.

/**
 * Upsert one program-derived planned session, idempotent on `plan_key`. Program
 * edits update the descriptive fields; realized state is preserved — `status`
 * and `gcal_event_id` are NEVER overwritten here, so re-seeding after a session
 * has been synced to Calendar or marked completed/skipped doesn't undo that.
 */
export async function upsertPlannedSession(
  s: PlannedSessionSpec,
): Promise<void> {
  await query(
    `INSERT INTO public.planned_sessions
       (date, block, week, session_kind, description,
        target_distance_km, target_hr_cap, target_session_type, plan_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (plan_key) DO UPDATE SET
       date                = EXCLUDED.date,
       block               = EXCLUDED.block,
       week                = EXCLUDED.week,
       session_kind        = EXCLUDED.session_kind,
       description         = EXCLUDED.description,
       target_distance_km  = EXCLUDED.target_distance_km,
       target_hr_cap       = EXCLUDED.target_hr_cap,
       target_session_type = EXCLUDED.target_session_type`,
    [
      s.dateISO,
      s.block,
      s.week,
      s.sessionKind,
      s.description,
      s.targetDistanceKm,
      s.targetHrCap,
      s.targetSessionType,
      s.planKey,
    ],
  );
}

/** A planned session row with its current calendar linkage, for the sync. */
export interface CalendarSyncRow extends PlannedSessionForEvent {
  id: string;
  gcalEventId: string | null;
  /** Linked "🧃 Fueling" companion event (Agon Meals calendar), or null. */
  gcalFuelingEventId: string | null;
  /** The event as Google held it after Agon's last push (MZY-417), or null. */
  gcalPushed: PushedEvent | null;
}

/** Lay a row's adjustment over its plan and shape it for the calendar sync. */
function toCalendarSyncRow(r: SessionRow): CalendarSyncRow {
  const { resolved, note } = resolveSessionRow(r);
  return {
    id: r.id,
    date: resolved.date,
    block: resolved.block,
    week: resolved.week,
    sessionKind: r.session_kind as 'run' | 'lift' | 'bike',
    description: resolved.description,
    targetDistanceKm: resolved.targetDistanceKm,
    targetHrCap: resolved.targetHrCap,
    targetSessionType: resolved.targetSessionType,
    gcalEventId: r.gcal_event_id,
    gcalFuelingEventId: r.gcal_fueling_event_id,
    gcalPushed: r.gcal_pushed,
    outcome: r.outcome,
    startTime: r.start_time,
    startTimePriority: r.start_time_priority,
    startTimeReason: r.start_time_reason,
    adjustmentNote: note,
    detail: resolved.detail,
  };
}

/**
 * Run/lift sessions whose RESOLVED date is on or after `fromISO`, oldest first.
 * Rest days are excluded (they don't sync to the calendar), and so are sessions
 * marked 'skipped' — the athlete has said they aren't doing that one, so it must
 * not reappear. Their already-created events are removed separately (see
 * getSkippedSessionsWithEvents). Each row is the program with its adjustment laid
 * over it, so the calendar shows reality while planned_sessions keeps the plan.
 */
export async function getSessionsToSync(
  fromISO: string,
): Promise<CalendarSyncRow[]> {
  const { rows } = await query<SessionRow>(
    `SELECT ${SESSION_SELECT}
     ${SESSION_FROM}
      WHERE COALESCE(a.date, p.date) >= $1
        AND p.session_kind <> 'rest'
        AND p.status <> 'skipped'
      ORDER BY COALESCE(a.date, p.date), p.session_kind`,
    [fromISO],
  );
  return rows.map(toCalendarSyncRow);
}

/** Record the created/linked Calendar event id and mark the session synced. */
export async function markSessionSynced(
  id: string,
  gcalEventId: string,
): Promise<void> {
  await query(
    `UPDATE public.planned_sessions
        SET gcal_event_id = $2, status = 'synced'
      WHERE id = $1`,
    [id, gcalEventId],
  );
}

/**
 * Remember the event exactly as Google returned it after Agon pushed it, so
 * reconcile can tell the athlete's edits from Agon's own writes (MZY-417).
 */
export async function recordPushedEvent(
  id: string,
  event: EventResource,
): Promise<void> {
  const pushed: PushedEvent = {
    dateTime: event.start?.dateTime,
    summary: event.summary,
    description: event.description,
  };
  await query(
    `UPDATE public.planned_sessions SET gcal_pushed = $2::jsonb WHERE id = $1`,
    [id, JSON.stringify(pushed)],
  );
}

/** Record the created/linked companion "🧃 Fueling" event id. */
export async function markFuelingEventSynced(
  id: string,
  gcalEventId: string,
): Promise<void> {
  await query(
    `UPDATE public.planned_sessions
        SET gcal_fueling_event_id = $2
      WHERE id = $1`,
    [id, gcalEventId],
  );
}

/**
 * Forget a session's fueling-event link, after that event has been deleted —
 * either because the athlete removed it, or because a program edit dropped the
 * session's distance back below LONG_RUN_REMINDER_KM. Mirrors
 * clearSessionEventLink for the main event.
 */
export async function clearFuelingEventLink(id: string): Promise<void> {
  await query(
    `UPDATE public.planned_sessions SET gcal_fueling_event_id = NULL WHERE id = $1`,
    [id],
  );
}

/** The first planned RUN session on a date (for attaching an ad-hoc route), or null. */
export async function getRunSessionForDate(
  dateISO: string,
): Promise<CalendarSyncRow | null> {
  const { rows } = await query<SessionRow>(
    `SELECT ${SESSION_SELECT}
     ${SESSION_FROM}
      WHERE COALESCE(a.date, p.date) = $1 AND p.session_kind = 'run'
      ORDER BY p.created_at
      LIMIT 1`,
    [dateISO],
  );
  return rows[0] ? toCalendarSyncRow(rows[0]) : null;
}

/**
 * Get-or-create a lightweight ad-hoc RUN session for a date (used when the athlete
 * requests a /route on a day with no planned run). Idempotent on plan_key
 * `adhoc-run:<date>` — one ad-hoc run per day; a second request reuses it and just
 * updates the target distance.
 */
export async function upsertAdHocRunSession(
  dateISO: string,
  targetKm: number,
): Promise<CalendarSyncRow> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.planned_sessions
       (date, session_kind, description, target_distance_km, plan_key)
     VALUES ($1, 'run', 'Ad hoc run', $2, $3)
     ON CONFLICT (plan_key) DO UPDATE SET target_distance_km = EXCLUDED.target_distance_km
     RETURNING id`,
    [dateISO, targetKm, `adhoc-run:${dateISO}`],
  );
  // Re-read through the joined view so an ad-hoc session created on a day that
  // already carries an adjustment resolves the same way as any other.
  const session = await getSessionById(rows[0]!.id);
  if (!session) throw new Error('adhoc run session vanished after insert');
  return session;
}

/** A skipped session that still has a calendar event (and/or fueling event) to take down. */
export interface SkippedSessionEvent {
  id: string;
  date: string;
  description: string;
  gcalEventId: string | null;
  gcalFuelingEventId: string | null;
}

/**
 * Skipped sessions on or after `fromISO` that still hold a calendar event
 * and/or a companion fueling event. Marking a session skipped keeps it OUT of
 * the sync (getSessionsToSync), but events created before it was skipped would
 * otherwise linger forever — nothing updates a row the sync no longer selects.
 * The sync deletes these.
 */
export async function getSkippedSessionsWithEvents(
  fromISO: string,
): Promise<SkippedSessionEvent[]> {
  const { rows } = await query<{
    id: string;
    date: string;
    description: string | null;
    gcal_event_id: string | null;
    gcal_fueling_event_id: string | null;
  }>(
    `SELECT p.id, to_char(COALESCE(a.date, p.date), 'YYYY-MM-DD') AS date,
            p.description, p.gcal_event_id, p.gcal_fueling_event_id
       ${SESSION_FROM}
      WHERE COALESCE(a.date, p.date) >= $1
        AND p.status = 'skipped'
        AND (p.gcal_event_id IS NOT NULL OR p.gcal_fueling_event_id IS NOT NULL)
      ORDER BY COALESCE(a.date, p.date)`,
    [fromISO],
  );
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    description: r.description ?? '',
    gcalEventId: r.gcal_event_id,
    gcalFuelingEventId: r.gcal_fueling_event_id,
  }));
}

/** Status values a session can be moved to by hand. */
export type SessionStatus = 'planned' | 'synced' | 'completed' | 'skipped';

/**
 * Set a session's status. This is the athlete saying what actually happened to a
 * session; it NEVER edits the program fields (date, distance, description), so
 * re-seeding from docs/training-program.local.md stays safe.
 */
export async function setSessionStatus(
  id: string,
  status: SessionStatus,
): Promise<void> {
  await query(`UPDATE public.planned_sessions SET status = $2 WHERE id = $1`, [
    id,
    status,
  ]);
}

/**
 * Forget the calendar event a session was linked to, after that event has been
 * deleted. Without this the id would dangle and an un-skip would try to patch an
 * event that no longer exists (a 404 the sync would then have to recover from).
 */
export async function clearSessionEventLink(id: string): Promise<void> {
  await query(
    `UPDATE public.planned_sessions SET gcal_event_id = NULL WHERE id = $1`,
    [id],
  );
}

/** Look up a session by date + kind, for CLIs that address it the way a human would. */
export async function findSessionByDateAndKind(
  dateISO: string,
  sessionKind: 'run' | 'lift' | 'bike' | 'rest',
): Promise<{ id: string; description: string; status: string } | null> {
  const { rows } = await query<{
    id: string;
    description: string | null;
    status: string;
  }>(
    `SELECT id, description, status
       FROM public.planned_sessions
      WHERE date = $1 AND session_kind = $2
      ORDER BY created_at
      LIMIT 1`,
    [dateISO, sessionKind],
  );
  return rows[0]
    ? {
        id: rows[0].id,
        description: rows[0].description ?? '',
        status: rows[0].status,
      }
    : null;
}

/**
 * Like findSessionByDateAndKind, but by the date the session sits on NOW (its
 * adjustment's date when it was moved, else the program date). A session dragged
 * in Calendar keeps its program date in planned_sessions.date, so "today's run"
 * by the calendar can be a row dated otherwise.
 */
export async function findSessionByCalendarDate(
  dateISO: string,
  sessionKind: 'run' | 'lift' | 'bike' | 'rest',
): Promise<{ id: string; description: string; status: string } | null> {
  const { rows } = await query<{
    id: string;
    description: string | null;
    status: string;
  }>(
    `SELECT p.id, COALESCE(a.description, p.description) AS description, p.status
       ${SESSION_FROM}
      WHERE COALESCE(a.date, p.date) = $1 AND p.session_kind = $2
      ORDER BY p.created_at
      LIMIT 1`,
    [dateISO, sessionKind],
  );
  return rows[0]
    ? {
        id: rows[0].id,
        description: rows[0].description ?? '',
        status: rows[0].status,
      }
    : null;
}

/**
 * Pin a session's start time (HH:MM, athlete-local) as a 'strong' one, so the
 * sync stops moving it back to the default slot. The one writer of start_time:
 * reconcile (a move read back from Calendar) and `session:adjust --at` both use it.
 */
export async function setSessionStartTime(
  id: string,
  startTime: string,
  reason: string,
): Promise<void> {
  await query(
    `UPDATE public.planned_sessions
        SET start_time = $2::time,
            start_time_priority = 'strong',
            start_time_reason = $3
      WHERE id = $1`,
    [id, startTime, reason],
  );
}

/** One session by id, resolved against its adjustment. */
export async function getSessionById(
  id: string,
): Promise<CalendarSyncRow | null> {
  const { rows } = await query<SessionRow>(
    `SELECT ${SESSION_SELECT} ${SESSION_FROM} WHERE p.id = $1`,
    [id],
  );
  return rows[0] ? toCalendarSyncRow(rows[0]) : null;
}

/**
 * Every session already linked to a calendar event, for the reconcile pass:
 * resolved on/after `fromISO`, OR linked to one of `eventIds` (the events
 * Calendar returned for the window) — so a session dragged forward into the
 * window from an earlier date is still examined (MZY-259).
 */
export async function getLinkedSessions(
  fromISO: string,
  eventIds: string[] = [],
): Promise<CalendarSyncRow[]> {
  const { rows } = await query<SessionRow>(
    `SELECT ${SESSION_SELECT}
     ${SESSION_FROM}
      WHERE (COALESCE(a.date, p.date) >= $1
             OR p.gcal_event_id = ANY($2::text[]))
        AND p.gcal_event_id IS NOT NULL
        AND p.session_kind <> 'rest'
      ORDER BY COALESCE(a.date, p.date)`,
    [fromISO, eventIds],
  );
  return rows.map(toCalendarSyncRow);
}
