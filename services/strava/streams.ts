import { z } from 'zod';
import { StravaRateLimitError } from './client';
import type { RideStreamData } from '../runStreams';

// Fetch + parse the Strava Activity Streams (the whole-run time series). Kept
// separate from the summary client because it is a per-activity call — far
// heavier on the rate limit. On by default in both sync and backfill
// (--no-streams opts out); resumable, since streamed activities are skipped.

const API_BASE = 'https://www.strava.com/api/v3';
// New keys go last so existing `keys=time,heartrate…` substring assertions
// hold. `watts` (MZY-267) comes back only for rides with power data; it is
// absent for runs, so the run path never sees it.
const STREAM_KEYS =
  'time,heartrate,distance,altitude,cadence,velocity_smooth,moving,latlng,watts';

const numberStream = z.object({ data: z.array(z.number().nullable()) });
const boolStream = z.object({ data: z.array(z.boolean()) });
// latlng samples are [lat, lng] pairs; a dropped point can be null.
const latlngStream = z.object({
  data: z.array(z.array(z.number()).nullable()),
});

// With key_by_type=true Strava returns an object keyed by stream type; each key
// is present only if that data exists for the activity.
const streamsSchema = z.object({
  time: numberStream.optional(),
  heartrate: numberStream.optional(),
  distance: numberStream.optional(),
  altitude: numberStream.optional(),
  cadence: numberStream.optional(),
  velocity_smooth: numberStream.optional(),
  moving: boolStream.optional(),
  latlng: latlngStream.optional(),
  watts: numberStream.optional(),
});

const roundOrNull = (v: number | null): number | null =>
  v == null ? null : Math.round(v);

/**
 * Returns the aligned time series for a Strava activity, or null when the
 * activity has no streams (404) or no `time` axis to align on. Throws
 * StravaRateLimitError on 429 so the backfill can stop and resume later.
 *
 * `watts` is returned unlabelled (`wattsSource` null): Strava's streams carry
 * no provenance, the activity summary's `device_watts` does — so ride callers
 * label it via withStravaWattsSource before storing.
 */
export async function fetchStravaRunStreams(
  accessToken: string,
  activityId: number,
): Promise<RideStreamData | null> {
  const res = await fetch(
    `${API_BASE}/activities/${activityId}/streams?keys=${STREAM_KEYS}&key_by_type=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (res.status === 429) {
    throw new StravaRateLimitError(
      `strava: rate limit hit fetching streams for ${activityId} (HTTP 429)`,
    );
  }
  if (res.status === 404) return null; // activity has no streams
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `strava: streams for ${activityId} failed (${res.status} ${res.statusText}) ${text}`,
    );
  }

  const parsed = streamsSchema.parse(await res.json());
  if (!parsed.time) return null; // no alignment axis — nothing to store

  // Split the [lat, lng] pairs into two index-aligned arrays (run_streams stores
  // lat[] and lng[] separately). A null pair → null in both.
  const latlng = parsed.latlng?.data ?? null;
  const lat = latlng?.map((p) => p?.[0] ?? null) ?? null;
  const lng = latlng?.map((p) => p?.[1] ?? null) ?? null;

  return {
    timeS: parsed.time.data.map((v) => Math.round(v ?? 0)),
    heartrate: parsed.heartrate?.data.map(roundOrNull) ?? null,
    distanceM: parsed.distance?.data ?? null,
    altitudeM: parsed.altitude?.data ?? null,
    cadence: parsed.cadence?.data.map(roundOrNull) ?? null,
    velocitySmoothMps: parsed.velocity_smooth?.data ?? null,
    moving: parsed.moving?.data ?? null,
    lat,
    lng,
    watts: parsed.watts?.data.map(roundOrNull) ?? null,
    wattsSource: null,
  };
}

/**
 * Label a Strava stream's watts with the activity's provenance: a power
 * meter ('device') when the summary says `device_watts`, otherwise Strava's
 * own model ('estimated'). A stream without watts passes through unchanged.
 */
export function withStravaWattsSource(
  streams: RideStreamData,
  deviceWatts: boolean | undefined,
): RideStreamData {
  if (!streams.watts) return { ...streams, watts: null, wattsSource: null };
  return {
    ...streams,
    wattsSource: deviceWatts === true ? 'device' : 'estimated',
  };
}
