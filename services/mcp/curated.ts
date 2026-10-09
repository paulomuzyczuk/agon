import { readQuery } from './readonlyDb';
import {
  getAthleteProfile,
  ftpEntryOn,
  type FtpEntry,
} from '../../lib/athleteProfile';
import { athleteLocalParts } from '../../lib/time';
import {
  computeBlockWeek,
  isBeyondModelledBlocks,
  programWeekRange,
  type BlockWeek,
  type DateRange,
} from '../../lib/training/trainingBlocks';
import {
  SESSION_SELECT,
  SESSION_FROM,
  RESOLVED_DATE,
  resolveSessionRow,
  type SessionRow,
} from '../plannedSessionView';

// Curated read-only tools: the common consulting questions as purpose-built
// queries returning compact markdown, so the model gets guided, correct answers
// without hand-writing SQL. The run_sql escape hatch covers everything else.

type Cell = string | number | null;

export function mdTable(headers: string[], rows: Cell[][]): string {
  if (rows.length === 0) return '_no rows_';
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows
    .map(
      (r) => `| ${r.map((c) => (c === null ? '' : String(c))).join(' | ')} |`,
    )
    .join('\n');
  return `${head}\n${sep}\n${body}`;
}

/** Athlete profile (config/athlete-profile.local.json) + program anchor — no DB. */
export function athleteProfile(): string {
  const p = getAthleteProfile();
  return [
    '## Athlete profile',
    '',
    `- Starting weight ${p.startingWeightKg} kg, body fat ${p.startingBodyFatPct}% (fallback weight if none logged: ${p.weightKgFallback} kg)`,
    `- Max HR ${p.hrMax} bpm, resting HR ${p.hrRest} bpm`,
    ftpLine(p.ftpHistory, p.timeZone),
    `- Sweat rate ${p.sweatRateBaselineLPerH} L/h (baseline, recalibrated by \`/sweat\` observations)`,
    `- Time zone: ${p.timeZone}`,
    '',
    '## Program',
    '',
    `- Start ${p.trainingStartDate}; ${p.programBlockCount} blocks × ${p.programWeeksPerBlock} weeks (Monday-aligned)`,
    "- See docs/training-program.local.md for this program's block-by-block detail.",
  ].join('\n');
}

/** Current FTP for the profile (MZY-269), or why IF/TSS are absent. */
function ftpLine(
  history: readonly FtpEntry[] | undefined,
  timeZone: string,
): string {
  const today = athleteLocalParts(new Date().toISOString(), timeZone).date;
  const entry = ftpEntryOn(today, history);
  return entry
    ? `- FTP ${entry.watts} W since ${entry.date} (anchors ride IF/TSS; measured power only)`
    : '- FTP: not set (ftpHistory) — ride IF/TSS are not computed';
}

/** Most recent runs with the headline metrics. */
export async function recentRuns(limit = 20): Promise<string> {
  const rows = await readQuery<{
    date: string;
    distance_km: string | null;
    duration_s: number | null;
    avg_hr: number | null;
    avg_pace_s_per_km: number | null;
    source: string | null;
  }>(
    `SELECT to_char(date,'YYYY-MM-DD') AS date, distance_km, duration_s,
            avg_hr, avg_pace_s_per_km, source
       FROM public.runs ORDER BY date DESC, started_at DESC NULLS LAST LIMIT $1`,
    [Math.min(Math.max(limit, 1), 100)],
  );
  const fmtPace = (s: number | null) =>
    s === null
      ? null
      : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}/km`;
  return mdTable(
    ['date', 'km', 'dur (min)', 'avg HR', 'pace', 'source'],
    rows.map((r) => [
      r.date,
      r.distance_km,
      r.duration_s === null ? null : Math.round(r.duration_s / 60),
      r.avg_hr,
      fmtPace(r.avg_pace_s_per_km),
      r.source,
    ]),
  );
}

/**
 * The planned sessions for the program week containing `dateISO` (default
 * today), RESOLVED against session_adjustments (MZY-265): a session sits on the
 * day the athlete moved it to, with their hand-edited title/distance/detail, and
 * the "adj" column says how it deviates from the program.
 */
export async function weeklyPlan(dateISO?: string): Promise<string> {
  const date = dateISO ?? new Date().toISOString().slice(0, 10);
  const range = programWeekRange(date) ?? { start: date, end: date };
  const rows = await readQuery<SessionRow>(
    `SELECT ${SESSION_SELECT}
     ${SESSION_FROM}
      WHERE ${RESOLVED_DATE} BETWEEN $1 AND $2
      ORDER BY ${RESOLVED_DATE}, p.start_time NULLS LAST, p.session_kind`,
    [range.start, range.end],
  );
  return formatWeeklyPlan(rows, range, computeBlockWeek(date));
}

/** Short weekday for a YYYY-MM-DD date (calendar date, so UTC is exact). */
function weekday(dateISO: string): string {
  return new Date(`${dateISO}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  });
}

/** An adjustment's detail (newline-joined, safe HTML) as one plain-text line. */
function detailLine(detail: string): string {
  return detail
    .split('\n')
    .map((l) => l.replace(/<[^>]*>/g, '').trim())
    .filter(Boolean)
    .join(' · ');
}

/**
 * Pure formatter for weeklyPlan, split out for unit tests. The header's block
 * comes from the sessions' own stamps when the week lies past the blocks
 * computeBlockWeek models — there it only clamps, and Block 4 would read
 * "Block 3" (the MZY-259 rule).
 */
export function formatWeeklyPlan(
  rows: SessionRow[],
  range: DateRange,
  computed: BlockWeek,
): string {
  const sessions = rows.map((r) => ({ row: r, ...resolveSessionRow(r) }));
  const stamped = sessions.find(
    (s) => s.resolved.week === computed.week && s.resolved.block !== null,
  )?.resolved.block;
  const block = isBeyondModelledBlocks(computed.week)
    ? (stamped ?? null)
    : computed.block;
  const header = `**Block ${block ?? '—'} · Week ${computed.week ?? '—'}** (${range.start} → ${range.end})\n\n`;
  const table = mdTable(
    [
      'date',
      'time',
      'kind',
      'description',
      'km',
      'HR cap',
      'type',
      'status',
      'adj',
    ],
    sessions.map(({ row, resolved, note }) => [
      `${weekday(resolved.date)} ${resolved.date}`,
      row.start_time,
      row.session_kind,
      resolved.description,
      resolved.targetDistanceKm,
      resolved.targetHrCap,
      resolved.targetSessionType,
      row.status,
      note,
    ]),
  );
  const details = sessions
    .filter((s) => s.resolved.detail)
    .map(
      (s) =>
        `- ${weekday(s.resolved.date)} ${s.resolved.date} ${s.row.session_kind}: ${detailLine(s.resolved.detail!)}`,
    );
  return (
    header +
    table +
    (details.length ? `\n\n**Athlete detail:**\n${details.join('\n')}` : '')
  );
}

/** Run + lift volume over a date range, plus per-week run distance. */
export async function trainingSummary(
  fromISO: string,
  toISO?: string,
): Promise<string> {
  const to = toISO ?? new Date().toISOString().slice(0, 10);
  const totals = await readQuery<{
    runs: string;
    run_km: string | null;
    rides: string;
    ride_km: string | null;
    lifts: string;
  }>(
    `SELECT
        (SELECT count(*) FROM public.runs WHERE date BETWEEN $1 AND $2) AS runs,
        (SELECT round(coalesce(sum(distance_km),0),1) FROM public.runs WHERE date BETWEEN $1 AND $2) AS run_km,
        (SELECT count(*) FROM public.rides WHERE date BETWEEN $1 AND $2) AS rides,
        (SELECT round(coalesce(sum(distance_km),0),1) FROM public.rides WHERE date BETWEEN $1 AND $2) AS ride_km,
        (SELECT count(*) FROM public.lifting_sessions WHERE date BETWEEN $1 AND $2) AS lifts`,
    [fromISO, to],
  );
  const perWeek = await readQuery<{
    week: number | null;
    run_km: string | null;
  }>(
    `SELECT week, round(coalesce(sum(distance_km),0),1) AS run_km
       FROM public.runs WHERE date BETWEEN $1 AND $2 GROUP BY week ORDER BY week`,
    [fromISO, to],
  );
  const t = totals[0];
  return (
    `**${fromISO} → ${to}** — ${t?.runs ?? 0} runs (${t?.run_km ?? 0} km), ` +
    `${t?.rides ?? 0} rides (${t?.ride_km ?? 0} km), ${t?.lifts ?? 0} lift sessions\n\n` +
    mdTable(
      ['program week', 'run km'],
      perWeek.map((w) => [w.week, w.run_km]),
    )
  );
}

/** Body weight / body-fat trend (default last 180 days). */
export async function bodyTrend(fromISO?: string): Promise<string> {
  const from = fromISO ?? '1900-01-01';
  const rows = await readQuery<{
    date: string;
    weight_kg: string | null;
    body_fat_pct: string | null;
  }>(
    `SELECT to_char(date,'YYYY-MM-DD') AS date, weight_kg, body_fat_pct
       FROM public.body_metrics WHERE date >= $1 ORDER BY date DESC LIMIT 90`,
    [from],
  );
  return mdTable(
    ['date', 'weight (kg)', 'body fat %'],
    rows.map((r) => [r.date, r.weight_kg, r.body_fat_pct]),
  );
}

/** Recent wellness — resting HR + steps, HRV, and sleep (default last 30 days). */
export async function wellnessSummary(fromISO?: string): Promise<string> {
  const from = fromISO ?? '1900-01-01';
  const rows = await readQuery<{
    date: string;
    resting_hr: number | null;
    steps: number | null;
    daily_rmssd: string | null;
    minutes_asleep: number | null;
    efficiency: number | null;
  }>(
    `SELECT to_char(d.date,'YYYY-MM-DD') AS date,
            d.resting_hr, d.steps, h.daily_rmssd,
            s.minutes_asleep, s.efficiency
       FROM public.daily_activity d
       LEFT JOIN public.hrv_daily h ON h.date = d.date
       LEFT JOIN public.sleep_sessions s ON s.date = d.date AND s.is_main_sleep
      WHERE d.date >= $1
      ORDER BY d.date DESC LIMIT 30`,
    [from],
  );
  return mdTable(
    [
      'date',
      'resting HR',
      'steps',
      'HRV (rmssd)',
      'sleep (min)',
      'sleep eff %',
    ],
    rows.map((r) => [
      r.date,
      r.resting_hr,
      r.steps,
      r.daily_rmssd,
      r.minutes_asleep,
      r.efficiency,
    ]),
  );
}

/** Freshest row per key table — a data-pipeline health check (dead-man's switch). */
export async function dataFreshness(): Promise<string> {
  const rows = await readQuery<{
    source: string;
    latest: string | null;
    n: string;
  }>(
    `SELECT 'runs' AS source, to_char(max(date),'YYYY-MM-DD') AS latest, count(*)::text AS n FROM public.runs
     UNION ALL SELECT 'rides', to_char(max(date),'YYYY-MM-DD'), count(*)::text FROM public.rides
     UNION ALL SELECT 'lifting_sessions', to_char(max(date),'YYYY-MM-DD'), count(*)::text FROM public.lifting_sessions
     UNION ALL SELECT 'body_metrics', to_char(max(date),'YYYY-MM-DD'), count(*)::text FROM public.body_metrics
     UNION ALL SELECT 'daily_activity', to_char(max(date),'YYYY-MM-DD'), count(*)::text FROM public.daily_activity
     UNION ALL SELECT 'sleep_sessions', to_char(max(date),'YYYY-MM-DD'), count(*)::text FROM public.sleep_sessions
     UNION ALL SELECT 'hrv_daily', to_char(max(date),'YYYY-MM-DD'), count(*)::text FROM public.hrv_daily
     UNION ALL SELECT 'nutrition_days', to_char(max(date),'YYYY-MM-DD'), count(*)::text FROM public.nutrition_days
     UNION ALL SELECT 'planned_sessions', to_char(max(date),'YYYY-MM-DD'), count(*)::text FROM public.planned_sessions
     ORDER BY source`,
  );
  return mdTable(
    ['table', 'latest date', 'rows'],
    rows.map((r) => [r.source, r.latest, r.n]),
  );
}

/**
 * Cross-domain general-health snapshot: recent lab test results (flagged
 * out-of-range markers called out first), active injuries, active
 * medications/supplements, active allergies/chronic conditions, routine
 * (skincare/dental) adherence over the last 7 days, and any upcoming
 * medical-visit/vaccination follow-ups. Read-only, same reimplement-on-the-
 * read-pool pattern as nutritionSummary.
 */
export async function healthSummary(): Promise<string> {
  const abnormalResults = await readQuery<{
    date: string;
    panel_type: string;
    marker: string;
    value_numeric: string | null;
    value_text: string | null;
    unit: string | null;
    flag: string | null;
  }>(
    `SELECT to_char(p.date,'YYYY-MM-DD') AS date, p.panel_type, r.marker,
            r.value_numeric, r.value_text, r.unit, r.flag
       FROM public.lab_panel_results r
       JOIN public.lab_panels p ON p.id = r.lab_panel_id
      WHERE r.flag IN ('low','high','abnormal')
        AND r.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY p.date DESC LIMIT 20`,
  );

  const recentPanels = await readQuery<{
    date: string;
    panel_type: string;
    lab_name: string | null;
  }>(
    `SELECT to_char(date,'YYYY-MM-DD') AS date, panel_type, lab_name
       FROM public.lab_panels WHERE deleted_at IS NULL ORDER BY date DESC LIMIT 10`,
  );

  const injuries = await readQuery<{
    body_part: string;
    status: string;
    severity: number | null;
    onset_date: string;
  }>(
    `SELECT body_part, status, severity, to_char(onset_date,'YYYY-MM-DD') AS onset_date
       FROM public.injuries WHERE status <> 'resolved' AND deleted_at IS NULL ORDER BY onset_date DESC`,
  );

  const medications = await readQuery<{
    name: string;
    kind: string;
    dosage: string | null;
    schedule: string | null;
  }>(
    `SELECT name, kind, dosage, schedule FROM public.medications
      WHERE active AND deleted_at IS NULL ORDER BY kind, name`,
  );

  const conditions = await readQuery<{
    condition_type: string;
    name: string;
    severity: string | null;
  }>(
    `SELECT condition_type, name, severity FROM public.health_conditions
      WHERE status = 'active' AND deleted_at IS NULL ORDER BY condition_type, name`,
  );

  const adherence = await readQuery<{
    routine_name: string;
    logged_days: string;
    completed_days: string;
  }>(
    `SELECT r.name AS routine_name, count(*) AS logged_days,
            count(*) FILTER (WHERE rl.completed) AS completed_days
       FROM public.routine_logs rl
       JOIN public.routines r ON r.id = rl.routine_id
      WHERE rl.date >= (current_date - interval '7 days')
        AND rl.deleted_at IS NULL AND r.deleted_at IS NULL
      GROUP BY r.name ORDER BY r.name`,
  );

  const followUps = await readQuery<{ what: string; due: string }>(
    `SELECT visit_type AS what, to_char(follow_up_date,'YYYY-MM-DD') AS due
       FROM public.medical_visits WHERE follow_up_date IS NOT NULL AND follow_up_date >= current_date AND deleted_at IS NULL
     UNION ALL
     SELECT vaccine AS what, to_char(next_due_date,'YYYY-MM-DD') AS due
       FROM public.vaccinations WHERE next_due_date IS NOT NULL AND next_due_date >= current_date AND deleted_at IS NULL
     ORDER BY due ASC LIMIT 10`,
  );

  const lines = [
    '## General health',
    '',
    '**Out-of-range lab results (most recent 20):**',
    mdTable(
      ['date', 'panel', 'marker', 'value', 'flag'],
      abnormalResults.map((r) => [
        r.date,
        r.panel_type,
        r.marker,
        r.value_numeric != null
          ? `${r.value_numeric}${r.unit ? ` ${r.unit}` : ''}`
          : r.value_text,
        r.flag,
      ]),
    ),
    '',
    '**Recent test panels:**',
    mdTable(
      ['date', 'panel', 'lab'],
      recentPanels.map((p) => [p.date, p.panel_type, p.lab_name]),
    ),
    '',
    '**Active injuries:**',
    injuries.length
      ? mdTable(
          ['onset', 'body part', 'status', 'severity'],
          injuries.map((i) => [
            i.onset_date,
            i.body_part,
            i.status,
            i.severity,
          ]),
        )
      : '_none_',
    '',
    '**Active medications/supplements:**',
    medications.length
      ? mdTable(
          ['name', 'kind', 'dosage', 'schedule'],
          medications.map((m) => [m.name, m.kind, m.dosage, m.schedule]),
        )
      : '_none_',
    '',
    '**Active allergies/chronic conditions:**',
    conditions.length
      ? mdTable(
          ['type', 'name', 'severity'],
          conditions.map((c) => [c.condition_type, c.name, c.severity]),
        )
      : '_none_',
    '',
    '**Skincare/dental routine adherence (last 7 days):**',
    adherence.length
      ? mdTable(
          ['routine', 'completed / logged'],
          adherence.map((a) => [
            a.routine_name,
            `${a.completed_days}/${a.logged_days}`,
          ]),
        )
      : '_no routines logged in the last 7 days_',
    '',
    '**Upcoming follow-ups:**',
    followUps.length
      ? mdTable(
          ['what', 'due'],
          followUps.map((f) => [f.what, f.due]),
        )
      : '_none scheduled_',
  ];
  return lines.join('\n');
}
