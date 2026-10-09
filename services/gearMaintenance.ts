import { query } from './db';
import type { MaintenanceTask, LastService } from '../lib/gearMaintenance';

// DB access for bike maintenance alerts. The due-status math is pure
// (lib/gearMaintenance.ts); this module only reads the catalog/log tables and
// writes new completed-service rows. Used by the /maintained Telegram
// command (services/telegram/handlers.ts), the /gear mart
// (services/marts/gear.ts), and scripts/check-gear-maintenance.ts.

export async function loadMaintenanceTasks(): Promise<MaintenanceTask[]> {
  const { rows } = await query<{
    task_key: string;
    name: string;
    interval_km: string | null;
    interval_days: number | null;
  }>(
    `SELECT task_key, name, interval_km, interval_days
       FROM public.gear_maintenance_tasks
      ORDER BY task_key`,
  );
  return rows.map((r) => ({
    taskKey: r.task_key,
    name: r.name,
    intervalKm: r.interval_km == null ? null : Number(r.interval_km),
    intervalDays: r.interval_days,
  }));
}

/**
 * The most recent completed service per (gear, task) pair, for every gear
 * item. One query for all gear — avoids an N+1 when gearMileage() computes
 * due-status per row.
 */
export async function loadLastServices(): Promise<Map<string, LastService[]>> {
  const { rows } = await query<{
    gear_id: string;
    task_key: string;
    performed_at: string;
    km_at_service: string;
  }>(
    `SELECT DISTINCT ON (gear_id, task_key)
            gear_id, task_key, performed_at::text AS performed_at, km_at_service
       FROM public.gear_maintenance_log
      ORDER BY gear_id, task_key, performed_at DESC`,
  );
  const byGear = new Map<string, LastService[]>();
  for (const r of rows) {
    const arr = byGear.get(r.gear_id) ?? [];
    arr.push({
      taskKey: r.task_key,
      performedAt: r.performed_at,
      kmAtService: Number(r.km_at_service),
    });
    byGear.set(r.gear_id, arr);
  }
  return byGear;
}

/** Active (non-retired) bikes — /maintained picks one via resolveBike(). */
export async function findActiveBikeGear(): Promise<
  { gearId: string; name: string }[]
> {
  const { rows } = await query<{ gear_id: string; name: string }>(
    `SELECT gear_id, name FROM public.gear
      WHERE category = 'bike' AND NOT retired
      ORDER BY name`,
  );
  return rows.map((r) => ({ gearId: r.gear_id, name: r.name }));
}

export async function findMaintenanceTask(
  taskKey: string,
): Promise<MaintenanceTask | null> {
  const { rows } = await query<{
    task_key: string;
    name: string;
    interval_km: string | null;
    interval_days: number | null;
  }>(
    `SELECT task_key, name, interval_km, interval_days
       FROM public.gear_maintenance_tasks
      WHERE task_key = $1`,
    [taskKey],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    taskKey: r.task_key,
    name: r.name,
    intervalKm: r.interval_km == null ? null : Number(r.interval_km),
    intervalDays: r.interval_days,
  };
}

export interface RecordMaintenanceLogInput {
  gearId: string;
  taskKey: string;
  /** YYYY-MM-DD. */
  performedAt: string;
  kmAtService: number;
}

/** Log a completed service; returns the new row id. */
export async function recordMaintenanceLog(
  input: RecordMaintenanceLogInput,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.gear_maintenance_log
       (gear_id, task_key, performed_at, km_at_service)
     VALUES ($1,$2,$3,$4)
     RETURNING id`,
    [input.gearId, input.taskKey, input.performedAt, input.kmAtService],
  );
  return rows[0]!.id;
}
