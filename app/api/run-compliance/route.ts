import { NextResponse } from 'next/server';
import { getRunComplianceWeeks } from '@/services/marts/runCompliance';
import { logger } from '@/services/logger';
import type { RunComplianceResponse } from '@/lib/marts';

// GET /api/run-compliance — weekly run compliance for the PWA view. Read-only
// over the dbt mart; writes stay in the ingestion pipeline (runs) and the
// planned-sessions seed. Never cached (the mart refreshes on `pnpm dbt build`).
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const weeks = await getRunComplianceWeeks();
    const body: RunComplianceResponse = { weeks };
    return NextResponse.json(body);
  } catch (err) {
    logger.error('run-compliance query failed', { route: '/api/run-compliance' }, err);
    return NextResponse.json({ error: 'run-compliance unavailable' }, { status: 503 });
  }
}
