import { NextResponse } from 'next/server';
import { getHealthSummary } from '@/services/marts/health';
import { logger } from '@/services/logger';
import type { HealthResponse } from '@/lib/marts';

// GET /api/general-health — cross-domain general-health snapshot (lab test
// results, skincare/dental routine adherence, active medications, active
// injuries, recent medical visits, upcoming follow-ups, vaccinations,
// allergies/conditions). Read-only; writes go through /api/general-health/log.
// Named distinctly from /api/health, which is the pre-existing liveness/
// DB-reachability probe n8n/uptime monitoring pings — do not repurpose that path.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const body: HealthResponse = await getHealthSummary();
    return NextResponse.json(body);
  } catch (err) {
    logger.error('general-health query failed', { route: '/api/general-health' }, err);
    return NextResponse.json({ error: 'general health data unavailable' }, { status: 503 });
  }
}
