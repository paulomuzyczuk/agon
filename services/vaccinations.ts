import { query } from './db';
import type { ClientRowKeys } from './clientWrite';

// Append-mostly immunization record.

export interface VaccinationInput extends ClientRowKeys {
  vaccine: string;
  date: string;
  doseNumber?: number | null;
  provider?: string | null;
  nextDueDate?: string | null;
  notes?: string | null;
}

export async function logVaccination(input: VaccinationInput): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.vaccinations (vaccine, date, dose_number, provider, next_due_date, notes, id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::uuid, gen_random_uuid()), COALESCE($8::timestamptz, now()))
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      input.vaccine,
      input.date,
      input.doseNumber ?? null,
      input.provider ?? null,
      input.nextDueDate ?? null,
      input.notes ?? null,
      input.id ?? null,
      input.capturedAt ?? null,
    ],
  );
  return rows[0]?.id ?? input.id!; // no row back = replay of a client write
}

export interface VaccinationSummary {
  id: string;
  vaccine: string;
  date: string;
  doseNumber: number | null;
  nextDueDate: string | null;
}

/** All vaccination records, most recent first. */
export async function listVaccinations(): Promise<VaccinationSummary[]> {
  const { rows } = await query<{
    id: string;
    vaccine: string;
    date: string;
    dose_number: number | null;
    next_due_date: string | null;
  }>(
    `SELECT id, vaccine, to_char(date,'YYYY-MM-DD') AS date, dose_number,
            to_char(next_due_date,'YYYY-MM-DD') AS next_due_date
       FROM public.vaccinations WHERE deleted_at IS NULL ORDER BY date DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    vaccine: r.vaccine,
    date: r.date,
    doseNumber: r.dose_number,
    nextDueDate: r.next_due_date,
  }));
}

/** Vaccinations with a next_due_date in the future (or overdue) — reminder surface. */
export async function listUpcomingVaccinations(): Promise<
  VaccinationSummary[]
> {
  const { rows } = await query<{
    id: string;
    vaccine: string;
    date: string;
    dose_number: number | null;
    next_due_date: string | null;
  }>(
    `SELECT id, vaccine, to_char(date,'YYYY-MM-DD') AS date, dose_number,
            to_char(next_due_date,'YYYY-MM-DD') AS next_due_date
       FROM public.vaccinations
      WHERE next_due_date IS NOT NULL AND deleted_at IS NULL
      ORDER BY next_due_date ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    vaccine: r.vaccine,
    date: r.date,
    doseNumber: r.dose_number,
    nextDueDate: r.next_due_date,
  }));
}
