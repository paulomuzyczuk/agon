import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listRuns } from '@/services/marts/runs';
import { logger } from '@/services/logger';
import type { RunsResponse } from '@/lib/marts';

// GET /api/runs?limit=30 — the recent-runs list for the PWA view. Reads the
// operational `runs` table directly (a run list is current-state browsing,
// not a derived time series), with Relative Effort joined in from the dbt
// mart. Writes stay in the ingestion adapters + Telegram.
export const dynamic = 'force-dynamic';

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
    const runs = await listRuns(parsed.data.limit);
    const body: RunsResponse = { runs };
    return NextResponse.json(body);
  } catch (err) {
    logger.error('runs query failed', { route: '/api/runs' }, err);
    return NextResponse.json({ error: 'runs unavailable' }, { status: 503 });
  }
}
