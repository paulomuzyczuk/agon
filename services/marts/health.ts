import { listLabPanels, listLabResultsFlat } from '../labResults';
import { listRoutines, getRoutineAdherence } from '../routines';
import { listMedications } from '../medications';
import { listInjuries } from '../injuries';
import { listMedicalVisits, listUpcomingFollowUps } from '../medicalVisits';
import { listVaccinations, listUpcomingVaccinations } from '../vaccinations';
import { listHealthConditions } from '../healthConditions';
import type {
  HealthResponse,
  RoutineAdherenceSummary,
  LabTrendsResponse,
} from '../../lib/marts';

// Read side of the /api/health boundary. Like nutrition, this is current-state
// operational data (not a time series), so it reads the operational tables
// directly via the services/ write-layer's list functions — no dbt mart.

function sevenDaysAgoIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

function aggregateAdherence(
  entries: { routineId: string; routineName: string; completed: boolean }[],
): RoutineAdherenceSummary[] {
  const byRoutine = new Map<string, RoutineAdherenceSummary>();
  for (const e of entries) {
    const existing = byRoutine.get(e.routineId) ?? {
      routineId: e.routineId,
      routineName: e.routineName,
      loggedDays: 0,
      completedDays: 0,
    };
    existing.loggedDays += 1;
    if (e.completed) existing.completedDays += 1;
    byRoutine.set(e.routineId, existing);
  }
  return [...byRoutine.values()].sort((a, b) => a.routineName.localeCompare(b.routineName));
}

export async function getHealthSummary(): Promise<HealthResponse> {
  const [
    recentLabPanels,
    routines,
    adherenceEntries,
    medications,
    injuries,
    recentMedicalVisits,
    visitFollowUps,
    vaccinationFollowUps,
    vaccinations,
    healthConditions,
  ] = await Promise.all([
    listLabPanels(20),
    listRoutines(),
    getRoutineAdherence(sevenDaysAgoIso()),
    listMedications(),
    listInjuries(),
    listMedicalVisits(10),
    listUpcomingFollowUps(),
    listUpcomingVaccinations(),
    listVaccinations(),
    listHealthConditions(),
  ]);

  const upcomingFollowUps = [
    ...visitFollowUps
      .filter((v) => v.followUpDate)
      .map((v) => ({ what: v.visitType, due: v.followUpDate as string })),
    ...vaccinationFollowUps
      .filter((v) => v.nextDueDate)
      .map((v) => ({ what: v.vaccine, due: v.nextDueDate as string })),
  ].sort((a, b) => a.due.localeCompare(b.due));

  return {
    recentLabPanels,
    routines,
    routineAdherence: aggregateAdherence(adherenceEntries),
    activeMedications: medications.filter((m) => m.active),
    activeInjuries: injuries.filter((i) => i.status !== 'resolved'),
    recentMedicalVisits,
    upcomingFollowUps,
    vaccinations,
    healthConditions: healthConditions.filter((c) => c.status === 'active'),
  };
}

/** Read side of GET /api/general-health/lab-trends — every result, unlimited, for the trend chart. */
export async function getLabTrends(): Promise<LabTrendsResponse> {
  return { results: await listLabResultsFlat() };
}
