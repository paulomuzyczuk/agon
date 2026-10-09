// Pure bike-maintenance due-status math, DB-free + unit-tested. Mirrors the
// pure/DB split of lib/relativeEffort.ts + services/relativeEffort.ts: this
// file only compares numbers; services/gearMaintenance.ts fetches them.

export interface MaintenanceTask {
  taskKey: string;
  name: string;
  intervalKm: number | null;
  intervalDays: number | null;
}

/** The most recent completed service for one (gear, task) pair. */
export interface LastService {
  taskKey: string;
  /** YYYY-MM-DD. */
  performedAt: string;
  /** The gear's total km (gearMileage) at the moment of service. */
  kmAtService: number;
}

export interface DueTask {
  taskKey: string;
  name: string;
  /** null only if the task has no km-based interval to measure against. */
  kmSinceService: number | null;
  /** null when the task has never been serviced (see module comment). */
  daysSinceService: number | null;
  intervalKm: number | null;
  intervalDays: number | null;
}

function daysBetween(fromISO: string, toISO: string): number {
  const from = new Date(`${fromISO}T00:00:00Z`).getTime();
  const to = new Date(`${toISO}T00:00:00Z`).getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

/**
 * Which of `tasks` are due for one gear item, given its current total km, the
 * most recent completed service per task (if any), and today's date.
 *
 * A task with no prior service is measured from 0 km (kmSinceService =
 * currentTotalKm). A days-based task with no prior service is deliberately
 * left un-measurable (daysSinceService = null, never flagged) rather than
 * guessing a start date — see the migration comment for why.
 */
export function computeDueTasks(
  tasks: MaintenanceTask[],
  lastServices: LastService[],
  currentTotalKm: number,
  todayISO: string,
): DueTask[] {
  const byTask = new Map(lastServices.map((s) => [s.taskKey, s]));
  const due: DueTask[] = [];

  for (const task of tasks) {
    const last = byTask.get(task.taskKey);
    const kmSinceService = currentTotalKm - (last?.kmAtService ?? 0);
    const daysSinceService = last
      ? daysBetween(last.performedAt, todayISO)
      : null;

    const kmDue = task.intervalKm != null && kmSinceService >= task.intervalKm;
    const daysDue =
      task.intervalDays != null &&
      daysSinceService != null &&
      daysSinceService >= task.intervalDays;

    if (kmDue || daysDue) {
      due.push({
        taskKey: task.taskKey,
        name: task.name,
        kmSinceService: task.intervalKm != null ? kmSinceService : null,
        daysSinceService,
        intervalKm: task.intervalKm,
        intervalDays: task.intervalDays,
      });
    }
  }
  return due;
}

export interface ActiveBike {
  gearId: string;
  name: string;
}

export type BikeResolution =
  | { ok: true; bike: ActiveBike }
  | {
      ok: false;
      reason: 'none' | 'ambiguous' | 'no-match';
      candidates: ActiveBike[];
    };

/**
 * Which active bike a /maintained entry belongs to (MZY-66). With no name
 * given, the one active bike is implied — more than one is ambiguous. With a
 * name, an exact case-insensitive match wins, else a unique substring match
 * ("canyon" → "Canyon Grail"); several substring hits are ambiguous. A name
 * is still checked with a single bike, so a typo never logs to the wrong one.
 */
export function resolveBike(
  bikes: ActiveBike[],
  name: string | null,
): BikeResolution {
  if (bikes.length === 0) return { ok: false, reason: 'none', candidates: [] };
  if (name == null) {
    return bikes.length === 1
      ? { ok: true, bike: bikes[0]! }
      : { ok: false, reason: 'ambiguous', candidates: bikes };
  }
  const needle = name.trim().toLowerCase();
  const exact = bikes.filter((b) => b.name.toLowerCase() === needle);
  if (exact.length === 1) return { ok: true, bike: exact[0]! };
  const partial = bikes.filter((b) => b.name.toLowerCase().includes(needle));
  if (partial.length === 1) return { ok: true, bike: partial[0]! };
  return partial.length > 1
    ? { ok: false, reason: 'ambiguous', candidates: partial }
    : { ok: false, reason: 'no-match', candidates: bikes };
}
