import { query, withTransaction } from './db';
import type { ClientRowKeys } from './clientWrite';

// Standalone injury/pain tracker — distinct from runs.pain_location, which is
// in-run-only. An injury has a status timeline (injury_updates) so severity
// and status changes over time without losing history.

export type InjuryStatus = 'active' | 'improving' | 'resolved';

export interface InjuryInput extends ClientRowKeys {
  onsetDate: string;
  bodyPart: string;
  description?: string | null;
  severity?: number | null; // 1-10
  notes?: string | null;
}

/** Log a new injury. */
export async function logInjury(input: InjuryInput): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.injuries (onset_date, body_part, description, severity, notes, id, created_at)
     VALUES ($1,$2,$3,$4,$5, COALESCE($6::uuid, gen_random_uuid()), COALESCE($7::timestamptz, now()))
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      input.onsetDate,
      input.bodyPart,
      input.description ?? null,
      input.severity ?? null,
      input.notes ?? null,
      input.id ?? null,
      input.capturedAt ?? null,
    ],
  );
  return rows[0]?.id ?? input.id!; // no row back = replay of a client write
}

/** Append a status update; when status is 'resolved', also stamps injuries.resolved_date. */
export async function addInjuryUpdate(
  input: ClientRowKeys & {
    injuryId: string;
    date: string;
    severity?: number | null;
    status?: InjuryStatus | null;
    notes?: string | null;
  },
): Promise<string> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO public.injury_updates (injury_id, date, severity, status, notes, id, created_at)
       VALUES ($1,$2,$3,$4,$5, COALESCE($6::uuid, gen_random_uuid()), COALESCE($7::timestamptz, now()))
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        input.injuryId,
        input.date,
        input.severity ?? null,
        input.status ?? null,
        input.notes ?? null,
        input.id ?? null,
        input.capturedAt ?? null,
      ],
    );
    // A replay (no row back) must not re-apply the status: a later update
    // may have moved the injury on since.
    if (!rows[0]) return input.id!;
    if (input.status) {
      await client.query(
        `UPDATE public.injuries
            SET status = $2, resolved_date = CASE WHEN $2 = 'resolved' THEN $3 ELSE resolved_date END
          WHERE id = $1`,
        [input.injuryId, input.status, input.date],
      );
    }
    return rows[0]!.id;
  });
}

export interface InjurySummary {
  id: string;
  onsetDate: string;
  bodyPart: string;
  description: string | null;
  severity: number | null;
  status: InjuryStatus;
  resolvedDate: string | null;
}

/** Injuries, most recent onset first. `status` filters (default: all). */
export async function listInjuries(
  status?: InjuryStatus,
): Promise<InjurySummary[]> {
  const { rows } = await query<{
    id: string;
    onset_date: string;
    body_part: string;
    description: string | null;
    severity: number | null;
    status: InjuryStatus;
    resolved_date: string | null;
  }>(
    status
      ? `SELECT id, to_char(onset_date,'YYYY-MM-DD') AS onset_date, body_part, description,
                severity, status, to_char(resolved_date,'YYYY-MM-DD') AS resolved_date
           FROM public.injuries WHERE status = $1 AND deleted_at IS NULL ORDER BY onset_date DESC`
      : `SELECT id, to_char(onset_date,'YYYY-MM-DD') AS onset_date, body_part, description,
                severity, status, to_char(resolved_date,'YYYY-MM-DD') AS resolved_date
           FROM public.injuries WHERE deleted_at IS NULL ORDER BY onset_date DESC`,
    status ? [status] : [],
  );
  return rows.map((r) => ({
    id: r.id,
    onsetDate: r.onset_date,
    bodyPart: r.body_part,
    description: r.description,
    severity: r.severity,
    status: r.status,
    resolvedDate: r.resolved_date,
  }));
}
