import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createRoutine, logRoutine } from '@/services/routines';
import { logLabPanel } from '@/services/labResults';
import { upsertMedication, logMedicationDose } from '@/services/medications';
import { logInjury, addInjuryUpdate } from '@/services/injuries';
import { logMedicalVisit } from '@/services/medicalVisits';
import { logVaccination } from '@/services/vaccinations';
import { upsertHealthCondition } from '@/services/healthConditions';
import { logger } from '@/services/logger';
import { captureDate } from '@/lib/time';
import { getAthleteProfile } from '@/lib/athleteProfile';
import { ClientWriteMetaSchema } from '@/services/clientWrite';

// POST /api/general-health/log — the PWA's general-health write path. One
// endpoint, mode-discriminated, mirroring /api/nutrition/log: each mode maps
// to exactly one services/ write function, so the route stays a thin
// validation boundary. Named distinctly from /api/health (the pre-existing
// liveness/DB-reachability probe) — see /api/general-health/route.ts.
//
// `medication` and `new_routine` (added for the PWA creation forms, Phase 3)
// create/upsert the parent record itself — distinct from `medication_dose`
// (logs a dose against an existing medication) and `routine` (logs adherence
// against an existing routine).
//
// Idempotent + device-timed (MZY-205), same contract as /api/nutrition/log:
// optional `clientId` (row id; replays are no-ops) and `capturedAt` (device
// time for the date default and created_at). See services/clientWrite.ts.
export const dynamic = 'force-dynamic';

const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const BodySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('routine'),
    date: DateSchema.optional(),
    routineId: z.string().uuid(),
    completed: z.boolean().optional(),
    notes: z.string().optional(),
  }),
  z.object({
    mode: z.literal('lab_panel'),
    date: DateSchema,
    panelType: z.string().min(1),
    labName: z.string().optional(),
    notes: z.string().optional(),
    results: z
      .array(
        z.object({
          marker: z.string().min(1),
          valueNumeric: z.number().optional(),
          valueText: z.string().optional(),
          unit: z.string().optional(),
          referenceLow: z.number().optional(),
          referenceHigh: z.number().optional(),
          flag: z.enum(['low', 'normal', 'high', 'abnormal']).optional(),
        }),
      )
      .min(1),
  }),
  z.object({
    mode: z.literal('medication'),
    name: z.string().min(1),
    kind: z.enum(['medication', 'supplement']),
    dosage: z.string().optional(),
    schedule: z.string().optional(),
    active: z.boolean().optional(),
    notes: z.string().optional(),
  }),
  z.object({
    mode: z.literal('new_routine'),
    name: z.string().min(1),
    routineType: z.enum(['skincare', 'dental']),
    timeOfDay: z.enum(['am', 'pm', 'any']).optional(),
    notes: z.string().optional(),
    steps: z
      .array(
        z.object({ product: z.string().min(1), notes: z.string().optional() }),
      )
      .min(1),
  }),
  z.object({
    mode: z.literal('medication_dose'),
    date: DateSchema.optional(),
    medicationName: z.string().min(1),
    quantity: z.number().positive().optional(),
    notes: z.string().optional(),
  }),
  z.object({
    mode: z.literal('injury'),
    onsetDate: DateSchema,
    bodyPart: z.string().min(1),
    description: z.string().optional(),
    severity: z.number().int().min(1).max(10).optional(),
    notes: z.string().optional(),
  }),
  z.object({
    mode: z.literal('injury_update'),
    injuryId: z.string().uuid(),
    date: DateSchema,
    severity: z.number().int().min(1).max(10).optional(),
    status: z.enum(['active', 'improving', 'resolved']).optional(),
    notes: z.string().optional(),
  }),
  z.object({
    mode: z.literal('medical_visit'),
    date: DateSchema,
    visitType: z.string().min(1),
    provider: z.string().optional(),
    reason: z.string().optional(),
    findings: z.string().optional(),
    followUpDate: DateSchema.optional(),
    notes: z.string().optional(),
  }),
  z.object({
    mode: z.literal('vaccination'),
    date: DateSchema,
    vaccine: z.string().min(1),
    doseNumber: z.number().int().positive().optional(),
    provider: z.string().optional(),
    nextDueDate: DateSchema.optional(),
    notes: z.string().optional(),
  }),
  z.object({
    mode: z.literal('health_condition'),
    conditionType: z.enum(['allergy', 'chronic_condition', 'other']),
    name: z.string().min(1),
    severity: z.string().optional(),
    diagnosedDate: DateSchema.optional(),
    status: z.enum(['active', 'resolved', 'managed']).optional(),
    notes: z.string().optional(),
  }),
]);

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;
  const meta = ClientWriteMetaSchema.safeParse(json);
  if (!meta.success) {
    return NextResponse.json(
      { error: 'invalid body', detail: meta.error.flatten() },
      { status: 400 },
    );
  }
  const { clientId, capturedAt } = meta.data;
  const keys = { id: clientId, capturedAt };
  const resolveDate = (date: string | undefined) =>
    captureDate(
      date,
      capturedAt,
      getAthleteProfile().timeZone,
      new Date().toISOString(),
    );

  try {
    switch (body.mode) {
      case 'routine': {
        const id = await logRoutine({
          ...keys,
          date: resolveDate(body.date),
          routineId: body.routineId,
          completed: body.completed,
          notes: body.notes,
        });
        return NextResponse.json({ id }, { status: 201 });
      }
      case 'lab_panel': {
        const id = await logLabPanel({
          ...keys,
          date: body.date,
          panelType: body.panelType,
          labName: body.labName,
          notes: body.notes,
          results: body.results,
        });
        return NextResponse.json({ id }, { status: 201 });
      }
      case 'medication': {
        const id = await upsertMedication({
          ...keys,
          name: body.name,
          kind: body.kind,
          dosage: body.dosage,
          schedule: body.schedule,
          active: body.active,
          notes: body.notes,
        });
        return NextResponse.json({ id }, { status: 201 });
      }
      case 'new_routine': {
        const id = await createRoutine({
          ...keys,
          name: body.name,
          routineType: body.routineType,
          timeOfDay: body.timeOfDay,
          notes: body.notes,
          steps: body.steps,
        });
        return NextResponse.json({ id }, { status: 201 });
      }
      case 'medication_dose': {
        const id = await logMedicationDose({
          ...keys,
          medicationName: body.medicationName,
          date: resolveDate(body.date),
          quantity: body.quantity,
          notes: body.notes,
        });
        return NextResponse.json({ id }, { status: 201 });
      }
      case 'injury': {
        const id = await logInjury({
          ...keys,
          onsetDate: body.onsetDate,
          bodyPart: body.bodyPart,
          description: body.description,
          severity: body.severity,
          notes: body.notes,
        });
        return NextResponse.json({ id }, { status: 201 });
      }
      case 'injury_update': {
        const id = await addInjuryUpdate({
          ...keys,
          injuryId: body.injuryId,
          date: body.date,
          severity: body.severity,
          status: body.status,
          notes: body.notes,
        });
        return NextResponse.json({ id }, { status: 201 });
      }
      case 'medical_visit': {
        const id = await logMedicalVisit({
          ...keys,
          date: body.date,
          visitType: body.visitType,
          provider: body.provider,
          reason: body.reason,
          findings: body.findings,
          followUpDate: body.followUpDate,
          notes: body.notes,
        });
        return NextResponse.json({ id }, { status: 201 });
      }
      case 'vaccination': {
        const id = await logVaccination({
          ...keys,
          date: body.date,
          vaccine: body.vaccine,
          doseNumber: body.doseNumber,
          provider: body.provider,
          nextDueDate: body.nextDueDate,
          notes: body.notes,
        });
        return NextResponse.json({ id }, { status: 201 });
      }
      case 'health_condition': {
        const id = await upsertHealthCondition({
          ...keys,
          conditionType: body.conditionType,
          name: body.name,
          severity: body.severity,
          diagnosedDate: body.diagnosedDate,
          status: body.status,
          notes: body.notes,
        });
        return NextResponse.json({ id }, { status: 201 });
      }
    }
  } catch (err) {
    logger.error('health log failed', { route: '/api/health/log' }, err);
    const message = err instanceof Error ? err.message : 'log failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
