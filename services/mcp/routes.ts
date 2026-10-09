import {
  suggestRoutes,
  candidateToGpx,
  candidateToMapsUrl,
  type StartInput,
  type RouteProfile,
  type HillPreference,
} from '../routing';

// Read-only MCP surface for the route builder (CLAUDE.md #6). Generates
// target-distance loops — or, given an end point and/or vias, one-way /
// through-X routes stretched to the target by a detour (MZY-215) — via the
// routing provider (an outbound OSM
// API call — no DB write, so it honours the MCP read-only invariant) and formats
// them as markdown. Persisting a batch and attaching one to a planned session
// are deliberate writes done via the CLIs (`pnpm route:suggest --save`,
// `pnpm route:attach`), not this tool.

export interface SuggestRoutesToolInput {
  targetKm: number;
  startPlace?: string;
  startLat?: number;
  startLng?: number;
  count?: number;
  includeGpx?: boolean;
  /** Travel mode. Default 'foot-walking' (existing behaviour). */
  profile?: RouteProfile;
  /** Gradient preference, cycling modes only. */
  hills?: HillPreference;
  /** Where to finish (geocoded). Omit (and endLat/endLng) for a loop. */
  endPlace?: string;
  endLat?: number;
  endLng?: number;
  /** Places/areas to pass through, in order ("Grunewald" → stays inside it). */
  via?: string[];
}

function resolveStart(input: SuggestRoutesToolInput): StartInput | undefined {
  if (
    typeof input.startLat === 'number' &&
    typeof input.startLng === 'number'
  ) {
    return { coord: { lat: input.startLat, lng: input.startLng } };
  }
  if (input.startPlace) return { place: input.startPlace };
  return undefined; // → home default
}

function resolveEnd(input: SuggestRoutesToolInput): StartInput | undefined {
  if (typeof input.endLat === 'number' && typeof input.endLng === 'number') {
    return { coord: { lat: input.endLat, lng: input.endLng } };
  }
  if (input.endPlace) return { place: input.endPlace };
  return undefined; // → finish back at the start
}

/** Generate + format route suggestions as markdown (with optional top-route GPX). */
export async function suggestRoutesText(
  input: SuggestRoutesToolInput,
): Promise<string> {
  const via = (input.via ?? []).map((s) => s.trim()).filter(Boolean);
  const result = await suggestRoutes({
    targetKm: input.targetKm,
    start: resolveStart(input),
    through: via.length ? via.map((place) => ({ place })) : undefined,
    finishNear: resolveEnd(input),
    keep: input.count ?? 3,
    profile: input.profile,
    hills: input.hills,
  });

  if (result.candidates.length === 0) {
    return `_No routes generated for ${input.targetKm} km._`;
  }

  const shape = [
    result.through?.length
      ? `through ${result.through
          .map((t) => (t.area ? `${t.label} (area)` : t.label))
          .join(', ')}`
      : '',
    result.oneWay && result.finish ? `one-way to ${result.finish.label}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const header =
    `**${result.candidates.length} route(s) for ${result.targetKm} km ` +
    `from ${result.start.label}${shape ? ` — ${shape}` : ''}**\n\n` +
    (result.geocodeWarnings ?? []).map((w) => `⚠️ _${w}_\n\n`).join('') +
    (result.spineOnly
      ? `_The direct route through these points is already ≥ ${result.targetKm} km; ` +
        'returned as-is, no detour added._\n\n'
      : '');

  const rows = result.candidates
    .map((c, i) => {
      const km = (c.distanceM / 1000).toFixed(2);
      const err = (c.distanceErrorM / 1000).toFixed(2);
      const gain =
        c.elevationGainM === null ? '—' : `+${Math.round(c.elevationGainM)} m`;
      const perKm =
        c.elevationGainPerKmM === null
          ? '—'
          : `${Math.round(c.elevationGainPerKmM)} m/km`;
      const map = candidateToMapsUrl(
        c,
        c.vias ?? result.through ?? [],
        result.profile,
      );
      return `| ${i + 1} | ${km} km | ${err} km | ${gain} | ${perKm} | ${c.seed} | [open](${map}) |`;
    })
    .join('\n');

  const table =
    '| # | distance | Δ target | climb | climb/km | seed | map |\n' +
    '| --- | --- | --- | --- | --- | --- | --- |\n' +
    rows;

  const cliArgs = [
    `--km ${result.targetKm}`,
    input.profile ? `--mode=${input.profile}` : '',
    input.hills ? `--hills=${input.hills}` : '',
    input.startPlace ? `--from="${input.startPlace}"` : '',
    via.length ? `--via="${via.join('; ')}"` : '',
    input.endPlace ? `--to="${input.endPlace}"` : '',
    typeof input.endLat === 'number' && typeof input.endLng === 'number'
      ? `--end-lat=${input.endLat} --end-lng=${input.endLng}`
      : '',
    '--save',
  ]
    .filter(Boolean)
    .join(' ');
  const footer =
    '\n\n_Save this set + export GPX for your watch:_ ' +
    `\`pnpm route:suggest ${cliArgs}\``;

  let out = header + table + footer;

  if (input.includeGpx) {
    const top = result.candidates[0]!;
    const gpx = candidateToGpx(top, {
      name: `Agon ${result.targetKm} km ${result.oneWay ? 'one-way route' : 'loop'} #1`,
      description: result.oneWay
        ? `from ${result.start.label} to ${result.finish?.label ?? '?'}`
        : `from ${result.start.label}`,
    });
    out += `\n\n**GPX for route #1:**\n\n\`\`\`xml\n${gpx}\`\`\``;
  }

  return out;
}
