import { query } from '@/services/db';
import type { GearMileageItem } from '@/lib/rideMarts';
import { computeDueTasks } from '@/lib/gearMaintenance';
import {
  loadMaintenanceTasks,
  loadLastServices,
} from '@/services/gearMaintenance';

// Read side of the gear-mileage view: total distance per gear item, summed
// across BOTH runs (via run_gear) and rides (via ride_gear) — the aggregate
// that was missing for shoes even before bikes existed (see the /gear view's
// own history). Reads the operational tables directly, same "current-state
// browsing, not a derived time series" reasoning as services/marts/runs.ts.
//
// Also attaches bike-maintenance due-status (lib/gearMaintenance.ts) per row —
// computed only for category='bike' gear, since the maintenance-task catalog
// isn't category-scoped and a shoe must never be flagged "chain lube overdue"
// off its run mileage.

interface GearMileageRow {
  gear_id: string;
  name: string;
  category: string;
  brand: string | null;
  retired: boolean;
  total_km: number | null;
  activity_count: string;
}

export async function gearMileage(): Promise<GearMileageItem[]> {
  const { rows } = await query<GearMileageRow>(
    `
    select
      g.gear_id,
      g.name,
      g.category,
      g.brand,
      g.retired,
      (coalesce(run_km.km, 0) + coalesce(ride_km.km, 0))::float8 as total_km,
      (coalesce(run_km.n, 0) + coalesce(ride_km.n, 0))::text     as activity_count
    from public.gear g
    left join (
      select rg.gear_id, sum(r.distance_km) as km, count(*) as n
        from public.run_gear rg
        join public.runs r on r.id = rg.run_id
       group by rg.gear_id
    ) run_km on run_km.gear_id = g.gear_id
    left join (
      select rg.gear_id, sum(r.distance_km) as km, count(*) as n
        from public.ride_gear rg
        join public.rides r on r.id = rg.ride_id
       group by rg.gear_id
    ) ride_km on ride_km.gear_id = g.gear_id
    order by g.retired, total_km desc nulls last, g.name
    `,
  );

  const [tasks, lastServicesByGear] = await Promise.all([
    loadMaintenanceTasks(),
    loadLastServices(),
  ]);
  const today = new Date().toISOString().slice(0, 10);

  return rows.map((r) => ({
    gearId: r.gear_id,
    name: r.name,
    category: r.category,
    brand: r.brand,
    retired: r.retired,
    totalKm: r.total_km,
    activityCount: Number(r.activity_count),
    dueMaintenanceTasks:
      r.category === 'bike'
        ? computeDueTasks(
            tasks,
            lastServicesByGear.get(r.gear_id) ?? [],
            r.total_km ?? 0,
            today,
          ).map((t) => t.name)
        : [],
  }));
}
