import { NextResponse } from 'next/server';
import { z } from 'zod';
import { pullChanges } from '@/services/sync/pull';
import { logger } from '@/services/logger';

// GET /api/sync/pull?since=<cursor>&limit=<n> — changed rows of every
// replicated table since the device's cursor, tombstones included, plus id
// aliases and the next cursor (MZY-206). Start from since=0 for full history.
export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});

export async function GET(request: Request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = QuerySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid query', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(await pullChanges(parsed.data.since, parsed.data.limit));
  } catch (err) {
    logger.error('sync pull failed', { route: '/api/sync/pull' }, err);
    return NextResponse.json({ error: 'pull failed' }, { status: 500 });
  }
}
