import type {
  HealthResponse,
  LabResultTrendRow,
  MealLogSummary,
  RoutineSummary,
} from '../marts';
import { live, type ReplicaRow, type ReplicaTables } from './replicaState';

// Read models rebuilt from the device replica (MZY-207) — the same shapes the
// server returns from /api/nutrition (meal part) and /api/general-health, so
// a page renders identically online and offline. Each mirrors its server
// counterpart (named per function); keep them in step. Pure.

const str = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const createdAt = (r: ReplicaRow) => String(r.created_at ?? '');
const byCreated = (a: ReplicaRow, b: ReplicaRow) =>
  createdAt(a).localeCompare(createdAt(b));

export interface FoodMacros {
  id: string;
  name: string;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

/** services/mealLogs.ts listMealLogsForDate + getDailyNutritionTotals. */
export function mealLogsView(
  tables: ReplicaTables,
  date: string,
  foods: FoodMacros[],
  templateNames: Map<string, string>,
): {
  todaysMealLogs: MealLogSummary[];
  loggedTotals: MealLogSummary['totals'];
} {
  const foodById = new Map(foods.map((f) => [f.id, f]));
  const items = live(tables, 'meal_log_items');
  const logs = live(tables, 'meal_logs')
    .filter((m) => m.date === date)
    .sort(byCreated)
    .map((m): MealLogSummary => {
      const mine = items
        .filter((i) => i.meal_log_id === m.id)
        .map((i) => ({
          i,
          food: foodById.get(String(i.food_id)),
          q: Number(i.quantity),
        }));
      const sum = (k: keyof FoodMacros) =>
        mine.reduce((s, x) => s + x.q * Number(x.food?.[k] ?? 0), 0);
      return {
        id: m.id,
        mealSlot: String(m.meal_slot),
        source: String(m.source ?? 'manual'),
        templateName: m.meal_template_id
          ? (templateNames.get(String(m.meal_template_id)) ?? null)
          : null,
        notes: str(m.notes),
        items: mine.map((x) => ({
          id: x.i.id,
          foodName: x.food?.name ?? 'unknown food',
          quantity: x.q,
        })),
        totals: {
          kcal: Math.round(sum('kcal')),
          proteinG: Math.round(sum('proteinG')),
          carbsG: Math.round(sum('carbsG')),
          fatG: Math.round(sum('fatG')),
        },
      };
    });
  // Day totals from the raw (unrounded) item sums, like the server's SQL SUM.
  const dayIds = new Set(logs.map((l) => l.id));
  const total = (k: keyof FoodMacros) =>
    Math.round(
      items
        .filter((i) => dayIds.has(String(i.meal_log_id)))
        .reduce(
          (s, i) =>
            s +
            Number(i.quantity) *
              Number(foodById.get(String(i.food_id))?.[k] ?? 0),
          0,
        ),
    );
  return {
    todaysMealLogs: logs,
    loggedTotals: {
      kcal: total('kcal'),
      proteinG: total('proteinG'),
      carbsG: total('carbsG'),
      fatG: total('fatG'),
    },
  };
}

function sevenDaysBefore(todayISO: string): string {
  const d = new Date(`${todayISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

/** services/marts/health.ts getHealthSummary. */
export function healthView(
  tables: ReplicaTables,
  todayISO: string,
): HealthResponse {
  const panels = live(tables, 'lab_panels').sort(
    (a, b) =>
      String(b.date).localeCompare(String(a.date)) ||
      createdAt(b).localeCompare(createdAt(a)),
  );
  const results = live(tables, 'lab_panel_results');
  const recentLabPanels = panels.slice(0, 20).map((p) => ({
    id: p.id,
    date: String(p.date),
    panelType: String(p.panel_type),
    labName: str(p.lab_name),
    results: results
      .filter((r) => r.lab_panel_id === p.id)
      .map((r) => ({
        marker: String(r.marker),
        valueNumeric: num(r.value_numeric),
        valueText: str(r.value_text),
        unit: str(r.unit),
        flag: (r.flag ?? null) as 'low' | 'normal' | 'high' | 'abnormal' | null,
        needsReview: Boolean(r.needs_review),
      })),
  }));

  const steps = live(tables, 'routine_steps').sort(
    (a, b) => Number(a.step_order) - Number(b.step_order),
  );
  const routineRows = live(tables, 'routines').sort(
    (a, b) =>
      String(a.routine_type).localeCompare(String(b.routine_type)) ||
      String(a.name).localeCompare(String(b.name)),
  );
  const routines: RoutineSummary[] = routineRows.map((r) => ({
    id: r.id,
    name: String(r.name),
    routineType: r.routine_type as RoutineSummary['routineType'],
    timeOfDay: (r.time_of_day ?? null) as RoutineSummary['timeOfDay'],
    steps: steps
      .filter((s) => s.routine_id === r.id)
      .map((s) => ({ product: String(s.product), notes: str(s.notes) })),
  }));
  const routineName = new Map(routineRows.map((r) => [r.id, String(r.name)]));
  const since = sevenDaysBefore(todayISO);
  const adherence = new Map<
    string,
    HealthResponse['routineAdherence'][number]
  >();
  for (const l of live(tables, 'routine_logs')) {
    const id = String(l.routine_id);
    if (String(l.date) < since || !routineName.has(id)) continue;
    const a = adherence.get(id) ?? {
      routineId: id,
      routineName: routineName.get(id)!,
      loggedDays: 0,
      completedDays: 0,
    };
    a.loggedDays += 1;
    if (l.completed) a.completedDays += 1;
    adherence.set(id, a);
  }

  const visits = live(tables, 'medical_visits').sort((a, b) =>
    String(b.date).localeCompare(String(a.date)),
  );
  const vaccinations = live(tables, 'vaccinations').sort((a, b) =>
    String(b.date).localeCompare(String(a.date)),
  );

  return {
    recentLabPanels,
    routines,
    routineAdherence: [...adherence.values()].sort((a, b) =>
      a.routineName.localeCompare(b.routineName),
    ),
    activeMedications: live(tables, 'medications')
      .filter((m) => m.active)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((m) => ({
        id: m.id,
        name: String(m.name),
        kind: m.kind as 'medication' | 'supplement',
        dosage: str(m.dosage),
        schedule: str(m.schedule),
        active: true,
        notes: str(m.notes), // the server's row carries it too (listMedications)
      })),
    activeInjuries: live(tables, 'injuries')
      .filter((i) => i.status !== 'resolved')
      .sort((a, b) => String(b.onset_date).localeCompare(String(a.onset_date)))
      .map((i) => ({
        id: i.id,
        onsetDate: String(i.onset_date),
        bodyPart: String(i.body_part),
        description: str(i.description),
        severity: num(i.severity),
        status: i.status as 'active' | 'improving' | 'resolved',
        resolvedDate: str(i.resolved_date),
      })),
    recentMedicalVisits: visits.slice(0, 10).map((v) => ({
      id: v.id,
      date: String(v.date),
      visitType: String(v.visit_type),
      provider: str(v.provider),
      reason: str(v.reason),
      findings: str(v.findings),
      followUpDate: str(v.follow_up_date),
    })),
    upcomingFollowUps: [
      ...visits
        .filter((v) => v.follow_up_date)
        .map((v) => ({
          what: String(v.visit_type),
          due: String(v.follow_up_date),
        })),
      ...vaccinations
        .filter((v) => v.next_due_date)
        .map((v) => ({
          what: String(v.vaccine),
          due: String(v.next_due_date),
        })),
    ].sort((a, b) => a.due.localeCompare(b.due)),
    vaccinations: vaccinations.map((v) => ({
      id: v.id,
      vaccine: String(v.vaccine),
      date: String(v.date),
      doseNumber: num(v.dose_number),
      nextDueDate: str(v.next_due_date),
    })),
    healthConditions: live(tables, 'health_conditions')
      .filter((c) => c.status === 'active')
      .sort(
        (a, b) =>
          String(a.condition_type).localeCompare(String(b.condition_type)) ||
          String(a.name).localeCompare(String(b.name)),
      )
      .map((c) => ({
        id: c.id,
        conditionType: c.condition_type as
          'allergy' | 'chronic_condition' | 'other',
        name: String(c.name),
        severity: str(c.severity),
        status: 'active' as const,
        diagnosedDate: str(c.diagnosed_date),
      })),
  };
}

/** services/labResults.ts listLabResultsFlat. */
export function labTrendsView(tables: ReplicaTables): {
  results: LabResultTrendRow[];
} {
  const panels = new Map(live(tables, 'lab_panels').map((p) => [p.id, p]));
  return {
    results: live(tables, 'lab_panel_results')
      .filter((r) => panels.has(String(r.lab_panel_id)))
      .map((r) => {
        const p = panels.get(String(r.lab_panel_id))!;
        return {
          date: String(p.date),
          panelType: String(p.panel_type),
          marker: String(r.marker),
          valueNumeric: num(r.value_numeric),
          unit: str(r.unit),
          referenceLow: num(r.reference_low),
          referenceHigh: num(r.reference_high),
          flag: (r.flag ?? null) as LabResultTrendRow['flag'],
          needsReview: Boolean(r.needs_review),
        };
      })
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          a.panelType.localeCompare(b.panelType),
      ),
  };
}
