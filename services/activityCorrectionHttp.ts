import { NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from './logger';
import {
  ActivityNotFoundError,
  applyCorrection,
  previewCorrection,
  revertCorrectionGroup,
} from './activityCorrectionFlow';
import {
  CorrectionError,
  type CorrectionActivityKind,
} from '../lib/activityCorrection';

// PATCH /api/runs/:id and /api/rides/:id (MZY-253) share this handler — the
// two routes differ only in the activity kind. zod at the boundary; the
// correction math and DB work are lib/activityCorrection.ts +
// services/activityCorrectionFlow.ts.

const ParamsSchema = z.object({ id: z.string().uuid() });

const CorrectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('missed_start'),
    addKm: z.number().positive().max(100),
  }),
  z.object({
    kind: z.literal('late_stop'),
    trimMin: z
      .number()
      .positive()
      .max(24 * 60),
  }),
  // An empty totals edit is rejected by planCorrection ('totals unchanged' →
  // 422); zod 3's discriminatedUnion can't hold a refined object.
  z.object({
    kind: z.literal('totals'),
    distanceKm: z.number().positive().max(1000).optional(),
    durationS: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 3600)
      .optional(),
  }),
]);

export const CorrectionBodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('correct'),
    corrections: z.array(CorrectionSchema).min(1).max(3),
    /** The athlete's own words — the qualitative_logs raw_transcript. */
    note: z.string().trim().max(2000).optional(),
    /** Preview only: return before → after, write nothing. */
    dryRun: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('revert'),
    group: z.enum(['totals', 'start']),
  }),
]);

export type CorrectionBody = z.infer<typeof CorrectionBodySchema>;

export async function handleCorrectionPatch(
  kind: CorrectionActivityKind,
  request: Request,
  params: Promise<{ id: string }>,
): Promise<NextResponse> {
  const route = `/api/${kind}s/[id]`;
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
  const b = CorrectionBodySchema.safeParse(json);
  if (!b.success) {
    return NextResponse.json(
      { error: 'invalid body', detail: b.error.flatten() },
      { status: 400 },
    );
  }
  const id = p.data.id;
  const body = b.data;

  try {
    if (body.action === 'revert') {
      const result = await revertCorrectionGroup(kind, id, body.group);
      logger.info('activity correction reverted', {
        route,
        kind,
        id,
        ...result,
      });
      return NextResponse.json(result);
    }
    if (body.dryRun) {
      return NextResponse.json(
        await previewCorrection(kind, id, body.corrections),
      );
    }
    const result = await applyCorrection(
      kind,
      id,
      body.corrections,
      body.note && body.note.length > 0 ? body.note : null,
    );
    logger.info('activity corrected', {
      route,
      kind,
      id,
      corrections: body.corrections.map((c) => c.kind),
      derivedFailed: result.derived.failed,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ActivityNotFoundError) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    if (err instanceof CorrectionError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    logger.error('activity correction failed', { route, kind, id }, err);
    return NextResponse.json({ error: 'correction failed' }, { status: 503 });
  }
}
