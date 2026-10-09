import { exportExerciseTcx } from './client';
import type { RideStreamData } from '../runStreams';

// Assemble the aligned run_streams time series for a Google Health run from its
// TCX export. Unlike Strava (whose Streams endpoint returns per-type arrays), the
// route/HR/distance samples live in a TCX document (see client.exportExerciseTcx),
// so we parse the <Trackpoint> list here.
//
// The parser is a pure function over the XML string — fully unit-testable with a
// fixture, and reused later by the generic GPX/FIT/TCX file importer (Workstream
// B). run_streams stores no lat/lng arrays (matching the Strava shape), so the
// route's FIRST point is returned separately to seed the run's start_lat/lng.

export interface GoogleHealthStreams {
  /**
   * Index-aligned series for run_streams/ride_streams, or null when the TCX
   * had no points. `watts` is only ever set for a ride with a power sensor;
   * the run path ignores it.
   */
  streams: RideStreamData | null;
  /** First route point (for runs.start_lat/lng), or null when route-less. */
  startLat: number | null;
  startLng: number | null;
}

const EMPTY: GoogleHealthStreams = {
  streams: null,
  startLat: null,
  startLng: null,
};

/** First capture group as a trimmed string, or null if the tag is absent. */
function match(block: string, re: RegExp): string | null {
  const m = re.exec(block);
  return m ? m[1]!.trim() : null;
}

function num(block: string, re: RegExp): number | null {
  const v = match(block, re);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a TCX document's trackpoints into an aligned RunStreamData plus the start
 * coordinates. Only trackpoints with a <Time> (the alignment axis) are kept;
 * per-sample fields absent on a point become null so every array stays the same
 * length as timeS. Returns EMPTY when there are no usable trackpoints.
 */
export function parseTcxTrackpoints(xml: string): GoogleHealthStreams {
  const blocks = xml.split(/<Trackpoint\b/i).slice(1);
  if (blocks.length === 0) return EMPTY;

  const times: number[] = []; // epoch ms, before rebasing to seconds-from-start
  const lat: Array<number | null> = [];
  const lng: Array<number | null> = [];
  const heartrate: Array<number | null> = [];
  const distanceM: Array<number | null> = [];
  const altitudeM: Array<number | null> = [];
  const cadence: Array<number | null> = [];
  const velocitySmoothMps: Array<number | null> = [];
  const watts: Array<number | null> = [];

  for (const block of blocks) {
    const timeStr = match(block, /<Time>([^<]+)<\/Time>/i);
    if (!timeStr) continue; // no alignment axis for this point — skip it
    const ms = Date.parse(timeStr);
    if (!Number.isFinite(ms)) continue;
    times.push(ms);
    lat.push(num(block, /<LatitudeDegrees>([^<]+)</i));
    lng.push(num(block, /<LongitudeDegrees>([^<]+)</i));
    // HeartRateBpm wraps a <Value>; match the value specifically.
    heartrate.push(num(block, /<HeartRateBpm>[\s\S]*?<Value>([^<]+)</i));
    distanceM.push(num(block, /<DistanceMeters>([^<]+)</i));
    altitudeM.push(num(block, /<AltitudeMeters>([^<]+)</i));
    // Cadence may be a bare <Cadence> or a namespaced RunCadence in Extensions.
    cadence.push(
      num(block, /<(?:\w+:)?RunCadence>([^<]+)</i) ??
        num(block, /<Cadence>([^<]+)</i),
    );
    velocitySmoothMps.push(num(block, /<(?:\w+:)?Speed>([^<]+)</i));
    // Garmin TPX extension power (<ns3:Watts>), MZY-267.
    watts.push(num(block, /<(?:\w+:)?Watts>([^<]+)</i));
  }

  if (times.length === 0) return EMPTY;

  const t0 = times[0]!;
  const timeS = times.map((ms) => Math.round((ms - t0) / 1000));

  // Only include an array when at least one sample carried that field — mirrors
  // Strava's "absent stream => null" so downstream code can tell "not measured"
  // from "measured all-null".
  const present = (a: Array<number | null>): boolean =>
    a.some((v) => v !== null);

  const firstLat = lat.find((v) => v !== null) ?? null;
  const firstLngIdx = lat.findIndex((v) => v !== null);
  const startLat = firstLat;
  const startLng = firstLngIdx >= 0 ? (lng[firstLngIdx] ?? null) : null;

  const streams: RideStreamData = {
    timeS,
    heartrate: present(heartrate) ? heartrate : null,
    distanceM: present(distanceM) ? distanceM : null,
    altitudeM: present(altitudeM) ? altitudeM : null,
    cadence: present(cadence) ? cadence : null,
    velocitySmoothMps: present(velocitySmoothMps) ? velocitySmoothMps : null,
    moving: null,
    // TCX carries no power model — a <Watts> sample can only come from a
    // sensor, so it is measured ('device') power.
    watts: present(watts)
      ? watts.map((w) => (w == null ? null : Math.round(w)))
      : null,
    wattsSource: present(watts) ? 'device' : null,
  };

  return { streams, startLat, startLng };
}

/**
 * Fetch a run's TCX export and parse it. Returns EMPTY on a route-less/empty
 * export. A GoogleHealthRateLimitError from the client propagates so the sync can
 * stop and resume later.
 */
export async function fetchGoogleHealthRunStreams(
  accessToken: string,
  dataPointName: string,
): Promise<GoogleHealthStreams> {
  const tcx = await exportExerciseTcx(accessToken, dataPointName);
  if (!tcx) return EMPTY;
  return parseTcxTrackpoints(tcx);
}
