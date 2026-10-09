import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getNutritionSummary } from '@/services/marts/nutrition';
import { logger } from '@/services/logger';
import { athleteLocalParts } from '@/lib/time';
import { getAthleteProfile } from '@/lib/athleteProfile';
import type { NutritionResponse } from '@/lib/marts';

// GET /api/nutrition?date=YYYY-MM-DD — today's (or a given date's) water goal,
// supplement targets, structured intake logged so far, the coarse nutrition_days
// row (future Cronometer import lands here), and the usual-meal templates for
// reference. Read-only; logging happens via Cronometer + services/mealLogs.ts,
// not this route.
export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
    .optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    date: url.searchParams.get('date') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid query', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const date =
    parsed.data.date ??
    athleteLocalParts(new Date().toISOString(), getAthleteProfile().timeZone).date;

  try {
    const body: NutritionResponse = await getNutritionSummary(date);
    return NextResponse.json(body);
  } catch (err) {
    logger.error('nutrition query failed', { route: '/api/nutrition' }, err);
    return NextResponse.json({ error: 'nutrition unavailable' }, { status: 503 });
  }
}
