import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getWellnessSeries,
  computeWellnessLatest,
} from '@/services/marts/wellness';
import { logger } from '@/services/logger';
import type { WellnessResponse } from '@/lib/marts';

// GET /api/wellness?days=60 — daily recovery signals (resting HR, HRV, sleep,
// active minutes) for the PWA wellness view. Read-only over the dbt mart; writes
// stay in the ingestion scripts (gh:wellness). Never cached (the mart refreshes
// on backfill).
export const dynamic = 'force-dynamic';

// Validate at the boundary (sihha convention: zod at every API edge). `days`
// bounded so a stray ?days=999999 can't ask for an unbounded scan.
const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(60),
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
    const series = await getWellnessSeries(parsed.data.days);
    const body: WellnessResponse = {
      series,
      latest: computeWellnessLatest(series),
    };
    return NextResponse.json(body);
  } catch (err) {
    logger.error('wellness query failed', { route: '/api/wellness' }, err);
    return NextResponse.json(
      { error: 'wellness unavailable' },
      { status: 503 },
    );
  }
}
