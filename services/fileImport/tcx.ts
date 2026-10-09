import type { DeclaredSummary, ParsedActivity, TrackPoint } from './track';

// TCX (Garmin Training Center) parser → ParsedActivity. TCX is the richest of the
// exportable text formats: trackpoints carry cumulative DistanceMeters and HR
// even on treadmill runs with no GPS, and Lap headers declare total time/distance
// as a fallback. Trackpoint extraction mirrors services/googleHealth/streams.ts
// (Google Health emits the same TCX schema); here we additionally keep absolute
// timestamps + the declared Lap summary.

function tag(block: string, re: RegExp): string | null {
  const m = re.exec(block);
  return m ? m[1]!.trim() : null;
}

function numTag(block: string, re: RegExp): number | null {
  const v = tag(block, re);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseTimeMs(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function parsePoint(block: string): TrackPoint {
  return {
    timeMs: parseTimeMs(tag(block, /<Time>([^<]+)<\/Time>/i)),
    lat: numTag(block, /<LatitudeDegrees>([^<]+)</i),
    lng: numTag(block, /<LongitudeDegrees>([^<]+)</i),
    altitudeM: numTag(block, /<AltitudeMeters>([^<]+)</i),
    // HeartRateBpm wraps a <Value>; match the value specifically.
    heartrate: numTag(block, /<HeartRateBpm>[\s\S]*?<Value>([^<]+)</i),
    // Cadence may be a bare <Cadence> or a namespaced RunCadence in Extensions.
    cadence:
      numTag(block, /<(?:\w+:)?RunCadence>([^<]+)</i) ??
      numTag(block, /<Cadence>([^<]+)</i),
    speedMps: numTag(block, /<(?:\w+:)?Speed>([^<]+)</i),
    distanceM: numTag(block, /<DistanceMeters>([^<]+)</i),
    // Garmin TPX extension power (<ns3:Watts>), MZY-267.
    watts: numTag(block, /<(?:\w+:)?Watts>([^<]+)</i),
  };
}

function declaredSummary(
  xml: string,
  firstPointMs: number | null,
): DeclaredSummary {
  // Activity <Id> is the start instant; fall back to the first Lap StartTime, then
  // the first trackpoint's time.
  const idTime = parseTimeMs(tag(xml, /<Id>([^<]+)<\/Id>/i));
  const lapStart = parseTimeMs(tag(xml, /<Lap\b[^>]*\bStartTime="([^"]+)"/i));
  const startTimeMs = idTime ?? lapStart ?? firstPointMs;

  // Sum lap-level totals across all laps. TotalTimeSeconds is lap-only; sum it.
  let totalTimeS: number | null = null;
  const lapTimeRe = /<TotalTimeSeconds>([^<]+)<\/TotalTimeSeconds>/gi;
  for (let m = lapTimeRe.exec(xml); m !== null; m = lapTimeRe.exec(xml)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) totalTimeS = (totalTimeS ?? 0) + n;
  }

  return { startTimeMs, totalTimeS, distanceM: null };
}

/** Parse a TCX document into a format-neutral ParsedActivity. */
export function parseTcx(xml: string): ParsedActivity {
  const creator =
    tag(xml, /<Creator\b[^>]*>[\s\S]*?<Name>([^<]+)<\/Name>/i) ??
    tag(xml, /<Author\b[^>]*>[\s\S]*?<Name>([^<]+)<\/Name>/i);

  const blocks = xml.split(/<Trackpoint\b/i).slice(1);
  const points: TrackPoint[] = [];
  for (const raw of blocks) {
    const end = raw.indexOf('</Trackpoint>');
    points.push(parsePoint(end >= 0 ? raw.slice(0, end) : raw));
  }

  const firstTimed = points.find((p) => p.timeMs !== null)?.timeMs ?? null;

  return {
    points,
    declared: declaredSummary(xml, firstTimed),
    creator,
  };
}
