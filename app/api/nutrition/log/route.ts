import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  logAdHocMeal,
  logMealFromTemplate,
  logWholeTemplateForDate,
} from '@/services/mealLogs';
import { logger } from '@/services/logger';
import { captureDate } from '@/lib/time';
import { getAthleteProfile } from '@/lib/athleteProfile';
import { ClientWriteMetaSchema } from '@/services/clientWrite';

// POST /api/nutrition/log — the PWA's meal-logging write path (interim, ahead
// of the Cronometer CSV import — see CLAUDE.md "Nutrition" decision
// 2026-08-24). Logs against the foods/meal_templates catalog only; there's no
// arbitrary macro entry, so every logged item resolves through the same
// case-insensitive food-name match the seed scripts use.
//
// Idempotent + device-timed (MZY-205): the PWA sends every write through its
// offline outbox with `clientId` (becomes the row id; a replayed flush is a
// no-op) and `capturedAt` (device time — decides the date when none is given,
// and becomes created_at). See services/clientWrite.ts.
export const dynamic = 'force-dynamic';

const MealSlotSchema = z.enum([
  'breakfast',
  'lunch',
  'dinner',
  'snack',
  'post_workout',
  'other',
]);

const BodySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('adhoc'),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    mealSlot: MealSlotSchema,
    items: z
      .array(
        z.object({ food: z.string().min(1), quantity: z.number().positive() }),
      )
      .min(1),
  }),
  z.object({
    mode: z.literal('template'),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    mealSlot: MealSlotSchema,
    templateName: z.string().min(1),
  }),
  z.object({
    mode: z.literal('whole_template'),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    templateName: z.string().min(1),
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
  const date = captureDate(
    body.date,
    capturedAt,
    getAthleteProfile().timeZone,
    new Date().toISOString(),
  );
  const keys = { id: clientId, capturedAt };

  try {
    if (body.mode === 'adhoc') {
      const id = await logAdHocMeal({
        ...keys,
        date,
        mealSlot: body.mealSlot,
        items: body.items,
      });
      return NextResponse.json({ ids: [id] }, { status: 201 });
    }
    if (body.mode === 'template') {
      const id = await logMealFromTemplate({
        ...keys,
        date,
        mealSlot: body.mealSlot,
        templateName: body.templateName,
      });
      return NextResponse.json({ ids: [id] }, { status: 201 });
    }
    const ids = await logWholeTemplateForDate({
      ...keys,
      date,
      templateName: body.templateName,
    });
    return NextResponse.json({ ids }, { status: 201 });
  } catch (err) {
    logger.error('meal log failed', { route: '/api/nutrition/log' }, err);
    const message = err instanceof Error ? err.message : 'log failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
