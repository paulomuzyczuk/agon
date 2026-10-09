import { NextResponse } from 'next/server';
import { z } from 'zod';
import { applyMutations } from '@/services/sync/apply';
import { logger } from '@/services/logger';

// POST /api/sync/push — field-level mutations from a device outbox (MZY-206).
// Each mutation is merged with mergeField() (services/sync/apply.ts); the
// response carries one result per mutation, in order: applied / skipped
// (lost the merge or a replay — both final, the outbox drops it) / rejected
// (invalid or violates a constraint — the outbox parks it as failed).
// Idempotent: replaying a batch returns all-skipped and changes nothing.
export const dynamic = 'force-dynamic';

const MAX_BATCH = 500;

const BodySchema = z.object({
  mutations: z
    .array(
      z.object({
        table: z.string().min(1).max(64),
        id: z.string().uuid(),
        field: z.string().min(1).max(64),
        value: z.unknown(),
        hlc: z.string().max(100),
        origin: z.enum(['human', 'machine']),
      }),
    )
    .min(1)
    .max(MAX_BATCH),
});

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    // A missing `value` reaches the per-field schema as undefined and is rejected there.
    const results = await applyMutations(
      parsed.data.mutations.map((m) => ({ ...m, value: m.value })),
    );
    return NextResponse.json({ results });
  } catch (err) {
    logger.error('sync push failed', { route: '/api/sync/push' }, err);
    return NextResponse.json({ error: 'push failed' }, { status: 500 });
  }
}
