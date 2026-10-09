import { NextResponse } from 'next/server';
import {
  getBodyCompSeries,
  computeBodyCompLatest,
  getBodyCompStarting,
} from '@/services/marts/bodyComp';
import { logger } from '@/services/logger';
import type { BodyCompResponse } from '@/lib/marts';

// GET /api/body-comp — full weight/BF% history for the PWA body-composition
// view. Read-only over the dbt mart; writes stay in Telegram (/weight, /bf).
// Never cached (the mart refreshes on backfill). No `?days=` window (unlike
// wellness/training-load) — weigh-ins are sparse enough that the whole trend
// is the useful unit.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const series = await getBodyCompSeries();
    const { startingWeightKg, startingBodyFatPct } = getBodyCompStarting();
    const body: BodyCompResponse = {
      series,
      latest: computeBodyCompLatest(series),
      startingWeightKg,
      startingBodyFatPct,
    };
    return NextResponse.json(body);
  } catch (err) {
    logger.error('body-comp query failed', { route: '/api/body-comp' }, err);
    return NextResponse.json(
      { error: 'body-comp unavailable' },
      { status: 503 },
    );
  }
}
