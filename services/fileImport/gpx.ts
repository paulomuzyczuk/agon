import type { ParsedActivity, TrackPoint } from './track';

// GPX 1.1 parser → ParsedActivity. GPX carries a bare GPS track (lat/lon/ele/time)
// with HR/cadence tucked into Garmin's TrackPointExtension namespace; it has no
// summary block, so distance/duration are derived from the track downstream.
//
// Regex/string parsing (no XML dependency) matches the codebase convention set by
// services/googleHealth/streams.ts. Robust to namespace prefixes (gpxtpx:, ns3:).

function attr(block: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]+)"`, 'i').exec(block);
  return m ? m[1]!.trim() : null;
}

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

function numAttr(block: string, name: string): number | null {
  const v = attr(block, name);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseTimeMs(block: string): number | null {
  const t = tag(block, /<time>([^<]+)<\/time>/i);
  if (t === null) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/** Parse a GPX document into a format-neutral ParsedActivity. */
export function parseGpx(xml: string): ParsedActivity {
  // creator= lives on the <gpx ...> root tag (not the <?xml?> declaration).
  const gpxOpen = /<gpx\b[^>]*>/i.exec(xml);
  const creator = gpxOpen ? attr(gpxOpen[0], 'creator') : null;

  // Declared start: the metadata <time>, if any (before the first trackpoint).
  const firstTrkpt = xml.indexOf('<trkpt');
  const metaTime = tag(
    xml.slice(0, firstTrkpt >= 0 ? firstTrkpt : xml.length),
    /<time>([^<]+)<\/time>/i,
  );
  const startTimeMs =
    metaTime && Number.isFinite(Date.parse(metaTime))
      ? Date.parse(metaTime)
      : null;

  const blocks = xml.split(/<trkpt\b/i).slice(1);
  const points: TrackPoint[] = [];
  for (const raw of blocks) {
    // Limit each block to the trackpoint's own markup so a following point's
    // fields can't bleed in.
    const end = raw.indexOf('</trkpt>');
    const block = end >= 0 ? raw.slice(0, end) : raw;
    const lat = numAttr(block, 'lat');
    const lng = numAttr(block, 'lon');
    points.push({
      timeMs: parseTimeMs(block),
      lat,
      lng,
      altitudeM: numTag(block, /<ele>([^<]+)<\/ele>/i),
      heartrate: numTag(block, /<(?:\w+:)?hr>([^<]+)</i),
      cadence: numTag(block, /<(?:\w+:)?cad>([^<]+)</i),
      speedMps: numTag(block, /<(?:\w+:)?speed>([^<]+)</i),
      distanceM: null, // GPX carries no cumulative distance
    });
  }

  return {
    points,
    declared: { startTimeMs, totalTimeS: null, distanceM: null },
    creator,
  };
}
