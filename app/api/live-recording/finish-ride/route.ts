import { NextResponse } from 'next/server';
import { finishLiveRecordingRide } from '@/services/liveRecordingRide';
import { FinishRideBodySchema } from '@/lib/liveRecordingRideBody';
import { logger } from '@/services/logger';
import { enrichMissingWeather } from '@/services/weather/enrich';
import { postSyncMissedStops } from '@/services/missedStops';

// POST /api/live-recording/finish-ride — the app/record flush path for a
// live-recorded RIDE (MZY-168), sibling to /finish (runs). Body carries the
// full HR/speed/cadence (+ power-meter, MZY-270) sample buffers read back out
// of IndexedDB (schema: lib/liveRecordingRideBody.ts); distanceKm is an
// optional override — without it the flush derives it from the GPS track or
// the wheel sensor (MZY-282), and a 400 asks for one when neither exists.
// Idempotent: recordingId is rides.external_id, so a retried flush (offline
// stop, retried on the browser's `online` event) upserts the same row instead
// of duplicating it.
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const parsed = FinishRideBodySchema.safeParse(json);
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
  if (
    body.samples.hr.length === 0 &&
    body.samples.speed.length === 0 &&
    body.samples.cadence.length === 0 &&
    body.samples.power.length === 0
  ) {
    return NextResponse.json({ error: 'no samples to save' }, { status: 400 });
  }

  try {
    const result = await finishLiveRecordingRide(body);
    // Weather for the new recording (MZY-226): at the GPS start position when
    // the app recorded a track (MZY-282), else the home location
    // (AGON_HOME_LAT/LNG) when set. Best-effort — never fails the flush.
    await enrichMissingWeather();
    await postSyncMissedStops(); // MZY-254 — best-effort, never fails the flush
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    logger.error(
      'live ride recording flush failed',
      { route: '/api/live-recording/finish-ride' },
      err,
    );
    const message = err instanceof Error ? err.message : 'flush failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
