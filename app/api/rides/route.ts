import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listRides } from '@/services/marts/rides';
import { logger } from '@/services/logger';
import type { RidesResponse } from '@/lib/rideMarts';

// GET /api/rides?limit=30 — the recent-rides list for the PWA view. Mirrors
// GET /api/runs.
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
    const rides = await listRides(parsed.data.limit);
    const body: RidesResponse = { rides };
    return NextResponse.json(body);
  } catch (err) {
    logger.error('rides query failed', { route: '/api/rides' }, err);
    return NextResponse.json({ error: 'rides unavailable' }, { status: 503 });
  }
}
