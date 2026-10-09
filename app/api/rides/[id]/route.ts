import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRideDetail } from '@/services/marts/rides';
import { logger } from '@/services/logger';
import { handleCorrectionPatch } from '@/services/activityCorrectionHttp';

// GET /api/rides/:id — one ride's full detail. Mirrors GET /api/runs/:id.
// PATCH /api/rides/:id — hand corrections, same as PATCH /api/runs/:id (MZY-253).
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }

  try {
    const ride = await getRideDetail(parsed.data.id);
    if (!ride) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    return NextResponse.json(ride);
  } catch (err) {
    logger.error('ride detail query failed', { route: '/api/rides/[id]' }, err);
    return NextResponse.json({ error: 'ride unavailable' }, { status: 503 });
  }
}

export function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleCorrectionPatch('ride', request, params);
}
