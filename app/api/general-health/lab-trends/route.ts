import { NextResponse } from 'next/server';
import { getLabTrends } from '@/services/marts/health';
import { logger } from '@/services/logger';
import type { LabTrendsResponse } from '@/lib/marts';

// GET /api/general-health/lab-trends — every lab marker result, flat and
// unlimited, for the trend chart (mirrors sihha's GET /api/psychometrics,
// which returns every psychometric_results row for the recipient with no
// cap — unlike /api/general-health's recentLabPanels, which is capped to the
// last 20 panels for the flat-list view).
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const body: LabTrendsResponse = await getLabTrends();
    return NextResponse.json(body);
  } catch (err) {
    logger.error('lab-trends query failed', { route: '/api/general-health/lab-trends' }, err);
    return NextResponse.json({ error: 'lab trends unavailable' }, { status: 503 });
  }
}
