import { query } from './db';
import { getLinkedSessions } from './plannedSessions';
import { upsertAdjustment } from './sessionAdjustments';
import {
  matchRealized,
  type Activity,
  type SessionToMatch,
} from '../lib/calendarRealized';
import { sameOutcome, type SessionOutcome } from '../lib/sessionOutcome';

// Make the calendar follow what the recorded data says happened (MZY-417). The
// matching is pure (lib/calendarRealized.ts); this is its DB side: read the
// window's activities, write each session's outcome, and lay the realized
// distance and start over the plan. Idempotent — a session whose outcome has not
// changed is not written again.

export interface RealizedChange {
  sessionId: string;
  date: string;
  description: string;
  outcome: SessionOutcome;
}

export interface RealizedSummary {
  /** Run/bike sessions in the window that were checked against the data. */
  examined: number;
  done: number;
  notDone: number;
  /** Outcomes that differ from what was stored (written unless a dry run). */
  changes: RealizedChange[];
}

/** Runs and rides in [fromISO, toISO], with their local start time. */
export async function loadActivities(
  fromISO: string,
  toISO: string,
  timeZone: string,
): Promise<Activity[]> {
  const { rows } = await query<{
    id: string;
    kind: 'run' | 'bike';
    d: string;
    start_local: string | null;
    km: string;
    duration_s: number | null;
    source: string;
  }>(
    `SELECT id::text, 'run' AS kind, date::text AS d,
            to_char(started_at AT TIME ZONE $3, 'HH24:MI') AS start_local,
            distance_km AS km, duration_s, source
       FROM public.runs WHERE date BETWEEN $1 AND $2
     UNION ALL
     SELECT id::text, 'bike', date::text,
            to_char(started_at AT TIME ZONE $3, 'HH24:MI'),
            distance_km, duration_s, source
       FROM public.rides WHERE date BETWEEN $1 AND $2`,
    [fromISO, toISO, timeZone],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    date: r.d,
    startLocal: r.start_local,
    km: Number(r.km),
    durationS: r.duration_s,
    source: r.source,
  }));
}

/** Lay one done outcome over its session: realized distance and start time. */
async function applyDone(id: string, o: SessionOutcome): Promise<void> {
  if (o.actualKm !== undefined) {
    await upsertAdjustment(id, { targetDistanceKm: o.actualKm }, 'realized');
  }
  if (o.actualStart) {
    await query(
      `UPDATE public.planned_sessions
          SET start_time = $2::time, start_time_priority = 'strong',
              start_time_reason = $3
        WHERE id = $1`,
      [id, o.actualStart, `actual start (${o.source ?? 'recorded'})`],
    );
  }
}

/**
 * Check every linked run/bike session dated in [fromISO, toISO] against the
 * recorded activities and store its outcome. `toISO` must be before today:
 * a session still to be done is not "not done".
 */
export async function reconcileRealized(opts: {
  fromISO: string;
  toISO: string;
  timeZone: string;
  dryRun?: boolean;
}): Promise<RealizedSummary> {
  const linked = (await getLinkedSessions(opts.fromISO)).filter(
    (s) => s.date <= opts.toISO && s.sessionKind !== 'lift',
  );
  const activities = await loadActivities(
    opts.fromISO,
    opts.toISO,
    opts.timeZone,
  );
  // The distance the PLAN asked for, kept across runs: after the first pass the
  // resolved target is the realized one, and the plan must not be lost.
  const planned = new Map(
    linked.map((s) => [s.id, s.outcome?.plannedKm ?? s.targetDistanceKm]),
  );
  const toMatch: SessionToMatch[] = linked.map((s) => ({
    id: s.id,
    date: s.date,
    sessionKind: s.sessionKind,
    targetSessionType: s.targetSessionType,
    targetDistanceKm: planned.get(s.id) ?? null,
  }));
  const matched = matchRealized(toMatch, activities, nextDay(opts.toISO));

  const changes: RealizedChange[] = [];
  for (const m of matched) {
    const session = linked.find((s) => s.id === m.sessionId)!;
    if (sameOutcome(session.outcome, m.outcome)) continue;
    changes.push({
      sessionId: m.sessionId,
      date: session.date,
      description: session.description,
      outcome: m.outcome,
    });
    if (opts.dryRun) continue;
    if (m.outcome.status === 'done') await applyDone(m.sessionId, m.outcome);
    await query(
      `UPDATE public.planned_sessions SET outcome = $2::jsonb WHERE id = $1`,
      [m.sessionId, JSON.stringify(m.outcome)],
    );
  }
  return {
    examined: matched.length,
    done: matched.filter((m) => m.outcome.status === 'done').length,
    notDone: matched.filter((m) => m.outcome.status === 'not_done').length,
    changes,
  };
}

/** The day after a YYYY-MM-DD date (matchRealized's exclusive `today` bound). */
function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
