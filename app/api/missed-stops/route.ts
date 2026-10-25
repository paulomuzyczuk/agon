import { NextResponse } from 'next/server';
import { logger } from '@/services/logger';
import { listOpenSuggestions } from '@/services/missedStops';
import type { OpenStopSuggestionsResponse } from '@/lib/missedStopDetection';

// GET /api/missed-stops — open missed-stop suggestions (MZY-254) for the
// dashboard. Without this list a suggestion was only visible on its own
// run/ride page, so with Telegram nudges off (2026-10-18) it went unseen.
// No query parameters; resolving stays POST /api/missed-stops/:id.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const open = await listOpenSuggestions();
    const body: OpenStopSuggestionsResponse = {
      suggestions: open.map((s) => ({
        id: s.id,
        kind: s.kind,
        date: s.date,
        confidence: s.confidence,
        trimS: s.trimS,
        href: `/${s.kind === 'run' ? 'runs' : 'rides'}/${s.activityId}`,
      })),
    };
    return NextResponse.json(body);
  } catch (err) {
    logger.error(
      'missed-stops list failed',
      { route: '/api/missed-stops' },
      err,
    );
    return NextResponse.json({ error: 'list failed' }, { status: 503 });
  }
}
