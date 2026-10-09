import { NextResponse } from 'next/server';
import { getRacePredictions } from '@/services/marts/racePredictions';
import { logger } from '@/services/logger';
import type { RacePredictionsResponse } from '@/lib/marts';

// GET /api/race-predictions — predicted race times (1k…70k) for the PWA. Read-only
// over the dbt mart; writes stay in the ingestion scripts (rp:backfill). Never
// cached (the mart refreshes on backfill). No query params: the mart is a small,
// fixed set of target distances, so the whole table is returned.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { predictions, fit } = await getRacePredictions();
    const body: RacePredictionsResponse = { predictions, fit };
    return NextResponse.json(body);
  } catch (err) {
    logger.error(
      'race-predictions query failed',
      { route: '/api/race-predictions' },
      err,
    );
    return NextResponse.json(
      { error: 'race-predictions unavailable' },
      { status: 503 },
    );
  }
}
