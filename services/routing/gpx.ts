import type { RouteCandidate } from './types';

// Pure GPX 1.1 serializer — the primary artifact runners load onto a watch
// (CLAUDE.md #6: "GPX is the primary artifact"). The inverse of the TCX/GPX
// parsing in services/googleHealth/streams.ts. No XML dependency (the parsers
// are hand-rolled too); kept pure so it's unit-tested against a fixture.

/** Escape the five XML predefined entities for safe attribute/text content. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface GpxOptions {
  /** <name> for the track, e.g. "Agon 25 km loop". */
  name?: string;
  /** Extra <desc> line. */
  description?: string;
}

/**
 * Serialize a route candidate's geometry to a GPX track. Coordinates are the
 * ORS [lng, lat] or [lng, lat, ele] tuples; altitude, when present, becomes an
 * <ele> element. Emits a single <trk>/<trkseg> — the shape a watch navigates.
 */
export function candidateToGpx(
  candidate: RouteCandidate,
  opts: GpxOptions = {},
): string {
  const name = opts.name ?? 'Agon route';
  const descParts = [
    opts.description,
    `${(candidate.distanceM / 1000).toFixed(2)} km`,
    candidate.elevationGainM !== null
      ? `+${candidate.elevationGainM} m elevation`
      : null,
    `via ${candidate.provider}`,
  ].filter(Boolean);

  const points = candidate.coordinates
    .map((c) => {
      const [lng, lat, ele] = c;
      const eleTag =
        typeof ele === 'number' ? `<ele>${ele.toFixed(1)}</ele>` : '';
      return `      <trkpt lat="${lat}" lon="${lng}">${eleTag}</trkpt>`;
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Agon" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <metadata>',
    `    <name>${xmlEscape(name)}</name>`,
    `    <desc>${xmlEscape(descParts.join(' · '))}</desc>`,
    '  </metadata>',
    '  <trk>',
    `    <name>${xmlEscape(name)}</name>`,
    '    <trkseg>',
    points,
    '    </trkseg>',
    '  </trk>',
    '</gpx>',
    '',
  ].join('\n');
}
