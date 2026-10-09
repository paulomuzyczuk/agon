import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRunDetail } from '@/services/marts/runs';
import { logger } from '@/services/logger';
import { handleCorrectionPatch } from '@/services/activityCorrectionHttp';

// GET /api/runs/:id — one run's full detail (run row + Relative Effort + its
// best available GPS/HR stream, downsampled) for the run-detail page.
// PATCH /api/runs/:id — hand corrections (missed start, late stop, totals) and
// their revert (MZY-253); body schema in services/activityCorrectionHttp.ts.
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
    const run = await getRunDetail(parsed.data.id);
    if (!run) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    return NextResponse.json(run);
  } catch (err) {
    logger.error('run detail query failed', { route: '/api/runs/[id]' }, err);
    return NextResponse.json({ error: 'run unavailable' }, { status: 503 });
  }
}

export function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleCorrectionPatch('run', request, params);
}
