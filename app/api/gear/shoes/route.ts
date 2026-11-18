import { NextResponse } from 'next/server';
import { listRunShoes } from '@/services/gear';
import { logger } from '@/services/logger';
import type { RunShoesResponse } from '@/lib/runShoes';

// GET /api/gear/shoes — the registered running shoes, most recently used first.
// Feeds the shoe dropdown of the Record page's Save form.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const body: RunShoesResponse = { shoes: await listRunShoes() };
    return NextResponse.json(body);
  } catch (err) {
    logger.error('shoes query failed', { route: '/api/gear/shoes' }, err);
    return NextResponse.json({ error: 'shoes unavailable' }, { status: 503 });
  }
}
