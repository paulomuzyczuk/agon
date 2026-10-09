import { NextResponse } from 'next/server';
import { finishLiveRecording } from '@/services/liveRecording';
import { FinishRunBodySchema } from '@/lib/liveRecordingRunBody';
import { logger } from '@/services/logger';
import { enrichMissingWeather } from '@/services/weather/enrich';
import { postSyncMissedStops } from '@/services/missedStops';

// POST /api/live-recording/finish — the app/record flush path (CLAUDE.md "Live
// Run Recording"). Body carries the full sample buffer the client read back out
// of IndexedDB; distanceKm is an optional override — without it the flush
// derives it from the GPS track (MZY-282), and a 400 asks for one when there
// is no track.
// Idempotent: recordingId is the runs.external_id, so a retried flush (offline
// stop, retried on the browser's `online` event) upserts the same row instead of
// duplicating it.
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const parsed = FinishRunBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  if (body.endedAt <= body.startedAt) {
    return NextResponse.json(
      { error: 'endedAt must be after startedAt' },
      { status: 400 },
    );
  }

  try {
    const result = await finishLiveRecording(body);
    // Weather for the new recording (MZY-226): at the GPS start position when
    // the app recorded a track (MZY-282), else the home location
    // (AGON_HOME_LAT/LNG) when set. Best-effort — never fails the flush.
    await enrichMissingWeather();
    await postSyncMissedStops(); // MZY-254 — best-effort, never fails the flush
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    logger.error(
      'live recording flush failed',
      { route: '/api/live-recording/finish' },
      err,
    );
    const message = err instanceof Error ? err.message : 'flush failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
