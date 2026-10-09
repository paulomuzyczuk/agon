import { NextResponse } from 'next/server';
import { query } from '@/services/db';
import { logger } from '@/services/logger';

// Liveness + DB-reachability probe. Establishes the app/api layer and gives
// n8n / uptime monitoring something to ping. Never cached.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await query('select 1 as ok');
    return NextResponse.json({ status: 'ok', db: 'reachable' });
  } catch (err) {
    logger.error('health check failed', { route: '/api/health' }, err);
    return NextResponse.json(
      { status: 'degraded', db: 'unreachable' },
      { status: 503 },
    );
  }
}
