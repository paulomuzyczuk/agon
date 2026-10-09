import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import {
  suggestRoutes,
  candidateToMapsUrl,
  ROUTE_PROFILES,
  HILL_PREFERENCES,
  type RouteProfile,
  type HillPreference,
} from '../services/routing';
import { formatClimb } from '../services/routing/elevation';
import {
  describeRouteVia,
  formatVia,
} from '../services/routing/routeDescription';
import { saveSuggestionBatch } from '../services/routeSuggestions';
import { logger } from '../services/logger';

// Generate target-distance running LOOP suggestions from a start point (default:
// the athlete's home, AGON_HOME_LAT/LNG) via OpenStreetMap routing
// (OpenRouteService). Prints a ranked table; with --save it persists the batch to
// route_suggestions and writes a .gpx file per candidate for the watch.
//
//   pnpm route:suggest --km 25
//   pnpm route:suggest --km 25 --from="Grunewald, Berlin"
//   pnpm route:suggest --km 25 --through="Tiergarten, Berlin" --finish="Alexanderplatz"
//   pnpm route:suggest --km 20 --mode=cycling-regular --via="Grunewald" --to="Schloßstraße 1, Steglitz"
//   pnpm route:suggest --km 25 --count=3 --save --out=./routes
//   pnpm route:suggest --km 30 --mode=cycling-regular
//   pnpm route:suggest --km 60 --mode=cycling-road --hills=flat
//
// Loops (round_trip) OR constrained routes: --through (alias --via) / --finish
// (alias --to, or --end-lat/--end-lng) build a point-to-point route through the
// waypoints, stretched to the target distance by a detour — inside the via when
// it names an area like a forest (services/routing/detour.ts), else off the
// longest leg; a padding loop is the fallback. --through is ';'-separated.
// A finish away from the start makes it a ONE-WAY route.
//
// --mode selects the ORS travel profile: foot-walking (default) or a cycling
// one — cycling-regular, cycling-road (paved), cycling-mountain (gravel/MTB).
// --hills=flat|hilly sets the gradient preference (cycling modes only).
// Existing run behaviour is unchanged unless passed.
//
// Weather-weighted by default (services/routing/weather.ts): ranks by forecast
// headwind exposure (a same-distance-band, same-ascent tiebreak) and prints a
// heat caveat when hot. One extra Open-Meteo call; --no-weather opts out.

// Accepts both `--km=25` and `--km 25` (the usage examples above use the
// space form; only `=` used to parse, so `--km 25` failed with the usage error).
function argVal(name: string): string | undefined {
  const argv = process.argv;
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  const i = argv.indexOf(`--${name}`);
  const next = i >= 0 ? argv[i + 1] : undefined;
  return next !== undefined && !next.startsWith('--') ? next : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  loadEnv();

  const kmRaw = argVal('km');
  const km = kmRaw ? Number(kmRaw) : NaN;
  if (!(km > 0)) {
    throw new Error(
      'usage: pnpm route:suggest --km <distance> [--from="place"] [--lat= --lng=] ' +
        '[--through|--via="A; B"] [--finish|--to="place" | --end-lat= --end-lng=] [--count=3] ' +
        `[--mode=${ROUTE_PROFILES.join('|')}] [--hills=${HILL_PREFERENCES.join('|')}] ` +
        '[--save] [--out=dir]',
    );
  }
  const modeArg = argVal('mode');
  if (modeArg && !(ROUTE_PROFILES as readonly string[]).includes(modeArg)) {
    throw new Error(
      `unknown --mode "${modeArg}" (expected ${ROUTE_PROFILES.join(', ')})`,
    );
  }
  const profile = modeArg as RouteProfile | undefined;
  const hillsArg = argVal('hills');
  if (hillsArg && !(HILL_PREFERENCES as readonly string[]).includes(hillsArg)) {
    throw new Error(
      `unknown --hills "${hillsArg}" (expected ${HILL_PREFERENCES.join(', ')})`,
    );
  }
  const hills = hillsArg as HillPreference | undefined;
  const place = argVal('from');
  const lat = argVal('lat');
  const lng = argVal('lng');
  const count = argVal('count') ? Number(argVal('count')) : 3;

  const start =
    lat && lng
      ? { coord: { lat: Number(lat), lng: Number(lng) } }
      : place
        ? { place }
        : undefined;

  // Constrained route (Premium-Parity #6): pass through waypoints / finish near a
  // place. --through is a SEMICOLON-separated list of place names (so a name may
  // itself contain a comma, e.g. --through="Tiergarten, Berlin; Kreuzberg").
  const throughArg = argVal('through') ?? argVal('via');
  const through = throughArg
    ? throughArg
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((place) => ({ place }))
    : undefined;
  const finishPlace = argVal('finish') ?? argVal('to');
  const endLat = argVal('end-lat');
  const endLng = argVal('end-lng');
  const finishNear =
    endLat && endLng
      ? { coord: { lat: Number(endLat), lng: Number(endLng) } }
      : finishPlace
        ? { place: finishPlace }
        : undefined;

  // Directionally-diverse by default (3 significantly different routes); --plain
  // reverts to top-N by distance accuracy.
  const diverse = !hasFlag('plain');
  const weather = !hasFlag('no-weather');
  const result = await suggestRoutes({
    targetKm: km,
    start,
    through,
    finishNear,
    keep: count,
    diverse,
    weather,
    profile,
    hills,
  });

  const constraintNote = [
    result.through?.length
      ? `through ${result.through.map((t) => t.label).join(', ')}`
      : '',
    result.oneWay && result.finish
      ? `one-way, finishing at ${result.finish.label}`
      : '',
  ]
    .filter(Boolean)
    .join(', ');
  for (const w of result.geocodeWarnings ?? []) {
    // eslint-disable-next-line no-console
    console.log(`\n⚠️  ${w}`);
  }
  if (result.spineOnly) {
    // eslint-disable-next-line no-console
    console.log(
      `\n⚠️  The through/finish route is already ${(result.candidates[0]!.distanceM / 1000).toFixed(1)} km ` +
        `(≥ your ${km} km target) — returning it as-is, no detour added.`,
    );
  }
  if (result.heatCaveat) {
    // eslint-disable-next-line no-console
    console.log(`\n🌡️  ${result.heatCaveat}`);
  }
  // eslint-disable-next-line no-console
  console.log(
    `\n${result.candidates.length} route(s) for ${km} km from ${result.start.label}` +
      `${constraintNote ? ` (${constraintNote})` : ''}:\n`,
  );
  for (let i = 0; i < result.candidates.length; i++) {
    const c = result.candidates[i]!;
    const dist = (c.distanceM / 1000).toFixed(2);
    const err = (c.distanceErrorM / 1000).toFixed(2);
    const gain = formatClimb(c.elevationGainM, c.distanceM) ?? 'elevation n/a';
    // Describe where each route goes (reverse geocoding) — same label the
    // calendar uses. Best-effort: skip on failure.
    let via = '';
    try {
      const places = await describeRouteVia(c.coordinates);
      if (places.length) via = ` — ${formatVia(places)}`;
    } catch {
      via = '';
    }
    const dir = c.direction ? ` ${c.direction}` : '';
    const wind =
      weather && c.windPenalty
        ? `  wind:${c.windPenalty.toFixed(0)}km/h-equiv`
        : '';
    // eslint-disable-next-line no-console
    console.log(
      `  #${i + 1}  ${dist} km (Δ${err})  ${gain}${dir}${wind}${via}\n      map: ${candidateToMapsUrl(c, c.vias ?? result.through ?? [], result.profile)}`,
    );
  }

  if (hasFlag('save')) {
    const { batchId, suggestions } = await saveSuggestionBatch(result);
    const outDir = argVal('out')
      ? resolve(process.cwd(), argVal('out')!)
      : process.cwd();
    // eslint-disable-next-line no-console
    console.log(
      `\nSaved batch ${batchId} (${suggestions.length} routes). GPX files:`,
    );
    for (const s of suggestions) {
      const file = resolve(
        outDir,
        `agon-route-${s.rank}-${s.id.slice(0, 8)}.gpx`,
      );
      writeFileSync(file, s.gpx, 'utf-8');
      // eslint-disable-next-line no-console
      console.log(`  #${s.rank}  ${file}\n      id: ${s.id}`);
    }
    // eslint-disable-next-line no-console
    console.log(
      `\nAttach one to a planned session: pnpm route:attach <suggestion-id> <planned-session-id>`,
    );
    logger.info('route:suggest saved', {
      job: 'route-suggest',
      batchId,
      count: suggestions.length,
    });
  } else {
    // eslint-disable-next-line no-console
    console.log(`\n(dry run — pass --save to persist + write GPX files)`);
  }
}

main()
  .catch((err) => {
    logger.error('suggest-route failed', { job: 'route-suggest' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
