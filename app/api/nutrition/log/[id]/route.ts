import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteMealLog } from '@/services/mealLogs';
import { logger } from '@/services/logger';

// DELETE /api/nutrition/log/:id — undo a logged meal (cascades to its items).
// Idempotent (MZY-205): deleting an id that's already gone is a success, not a
// 404 — the outbox retries a delete whose first response was lost, and that
// retry must not surface as a failure.
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }

  try {
    const deleted = await deleteMealLog(parsed.data.id);
    return NextResponse.json({ ok: true, deleted });
  } catch (err) {
    logger.error(
      'meal log delete failed',
      { route: '/api/nutrition/log/[id]' },
      err,
    );
    return NextResponse.json({ error: 'delete failed' }, { status: 500 });
  }
}
