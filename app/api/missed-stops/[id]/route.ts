import { NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/services/logger';
import {
  resolveSuggestion,
  SuggestionStateError,
} from '@/services/missedStops';

// POST /api/missed-stops/:id — apply (the MZY-253 late-stop trim) or dismiss
// an open missed-stop suggestion (MZY-254) from the run/ride detail page.
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid() });
const BodySchema = z.object({ action: z.enum(['apply', 'dismiss']) });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const p = ParamsSchema.safeParse(await params);
  if (!p.success) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const b = BodySchema.safeParse(json);
  if (!b.success) {
    return NextResponse.json(
      { error: 'invalid body', detail: b.error.flatten() },
      { status: 400 },
    );
  }
  try {
    const r = await resolveSuggestion({ id: p.data.id }, b.data.action);
    logger.info('missed-stop suggestion resolved', {
      route: '/api/missed-stops/[id]',
      id: p.data.id,
      outcome: r.status,
    });
    return NextResponse.json({ status: r.status });
  } catch (err) {
    if (err instanceof SuggestionStateError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    logger.error(
      'missed-stop resolve failed',
      { route: '/api/missed-stops/[id]', id: p.data.id },
      err,
    );
    return NextResponse.json({ error: 'resolve failed' }, { status: 503 });
  }
}
