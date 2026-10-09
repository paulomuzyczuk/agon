import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getTrainingLoadSeries } from '@/services/marts/trainingLoad';
import { logger } from '@/services/logger';
import type { TrainingLoadResponse } from '@/lib/marts';

// GET /api/training-load?days=90 — the Fitness/Fatigue/Form (CTL/ATL/TSB) series
// for the PWA training-load view. Read-only over the dbt mart; writes stay in the
// ingestion scripts + Telegram. Never cached (the mart refreshes on backfill).
export const dynamic = 'force-dynamic';

// Validate at the boundary (sihha convention: zod at every API edge). `days`
// bounded so a stray ?days=999999 can't ask for an unbounded scan.
const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(90),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    days: url.searchParams.get('days') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid query', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const series = await getTrainingLoadSeries(parsed.data.days);
    const body: TrainingLoadResponse = {
      series,
      latest: series.at(-1) ?? null,
    };
    return NextResponse.json(body);
  } catch (err) {
    logger.error(
      'training-load query failed',
      { route: '/api/training-load' },
      err,
    );
    return NextResponse.json(
      { error: 'training-load unavailable' },
      { status: 503 },
    );
  }
}
