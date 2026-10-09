import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRelativeEffortRuns } from '@/services/marts/relativeEffort';
import { logger } from '@/services/logger';
import type { RelativeEffortResponse } from '@/lib/marts';

// GET /api/relative-effort?limit=30 — recent per-run Relative Effort (Banister
// TRIMP) for the PWA view. Read-only over the dbt mart; writes stay in the
// ingestion scripts (re:backfill). Never cached (the mart refreshes on backfill).
export const dynamic = 'force-dynamic';

// Validate at the boundary (sihha convention: zod at every API edge). `limit`
// bounded so a stray ?limit=999999 can't ask for an unbounded scan.
const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(30),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid query', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const runs = await getRelativeEffortRuns(parsed.data.limit);
    const body: RelativeEffortResponse = { runs };
    return NextResponse.json(body);
  } catch (err) {
    logger.error(
      'relative-effort query failed',
      { route: '/api/relative-effort' },
      err,
    );
    return NextResponse.json(
      { error: 'relative-effort unavailable' },
      { status: 503 },
    );
  }
}
