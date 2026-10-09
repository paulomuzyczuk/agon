import { NextResponse } from 'next/server';
import { listFoods } from '@/services/foods';
import { logger } from '@/services/logger';

// GET /api/nutrition/foods — the foods catalog, for the PWA's ad-hoc meal
// logging picker. Read-only; the catalog itself is seeded via `pnpm seed:foods`.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const foods = await listFoods();
    return NextResponse.json({ foods });
  } catch (err) {
    logger.error('foods query failed', { route: '/api/nutrition/foods' }, err);
    return NextResponse.json({ error: 'foods unavailable' }, { status: 503 });
  }
}
