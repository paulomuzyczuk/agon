import { query } from './db';
import type { ClientRowKeys } from './clientWrite';

// Doctor/dentist/specialist appointments — one row per visit. visit_type is
// open text ('general_checkup' / 'dental_cleaning' / 'dermatologist' / ...),
// same rationale as lab_panels.panel_type.

export interface MedicalVisitInput extends ClientRowKeys {
  date: string;
  visitType: string;
  provider?: string | null;
  reason?: string | null;
  findings?: string | null;
  followUpDate?: string | null;
  notes?: string | null;
}

export async function logMedicalVisit(
  input: MedicalVisitInput,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.medical_visits (date, visit_type, provider, reason, findings, follow_up_date, notes, id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::uuid, gen_random_uuid()), COALESCE($9::timestamptz, now()))
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      input.date,
      input.visitType,
      input.provider ?? null,
      input.reason ?? null,
      input.findings ?? null,
      input.followUpDate ?? null,
      input.notes ?? null,
      input.id ?? null,
      input.capturedAt ?? null,
    ],
  );
  return rows[0]?.id ?? input.id!; // no row back = replay of a client write
}

export interface MedicalVisitSummary {
  id: string;
  date: string;
  visitType: string;
  provider: string | null;
  reason: string | null;
  findings: string | null;
  followUpDate: string | null;
}

/** Most recent visits (default 20). */
export async function listMedicalVisits(
  limit = 20,
): Promise<MedicalVisitSummary[]> {
  const { rows } = await query<{
    id: string;
    date: string;
    visit_type: string;
    provider: string | null;
    reason: string | null;
    findings: string | null;
    follow_up_date: string | null;
  }>(
    `SELECT id, to_char(date,'YYYY-MM-DD') AS date, visit_type, provider, reason, findings,
            to_char(follow_up_date,'YYYY-MM-DD') AS follow_up_date
       FROM public.medical_visits WHERE deleted_at IS NULL ORDER BY date DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    visitType: r.visit_type,
    provider: r.provider,
    reason: r.reason,
    findings: r.findings,
    followUpDate: r.follow_up_date,
  }));
}

/** Visits with an upcoming (or overdue) follow-up date — reminder surface. */
export async function listUpcomingFollowUps(): Promise<MedicalVisitSummary[]> {
  const { rows } = await query<{
    id: string;
    date: string;
    visit_type: string;
    provider: string | null;
    reason: string | null;
    findings: string | null;
    follow_up_date: string | null;
  }>(
    `SELECT id, to_char(date,'YYYY-MM-DD') AS date, visit_type, provider, reason, findings,
            to_char(follow_up_date,'YYYY-MM-DD') AS follow_up_date
       FROM public.medical_visits
      WHERE follow_up_date IS NOT NULL AND deleted_at IS NULL
      ORDER BY follow_up_date ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    visitType: r.visit_type,
    provider: r.provider,
    reason: r.reason,
    findings: r.findings,
    followUpDate: r.follow_up_date,
  }));
}
