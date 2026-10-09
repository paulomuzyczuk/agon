import { NextResponse } from 'next/server';
import { gearMileage } from '@/services/marts/gear';
import { logger } from '@/services/logger';
import type { GearResponse } from '@/lib/rideMarts';

// GET /api/gear — total mileage per gear item (shoes + bikes + ...), summed
// across runs and rides.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const gear = await gearMileage();
    const body: GearResponse = { gear };
    return NextResponse.json(body);
  } catch (err) {
    logger.error('gear query failed', { route: '/api/gear' }, err);
    return NextResponse.json({ error: 'gear unavailable' }, { status: 503 });
  }
}
