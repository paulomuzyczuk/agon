import { orsFetch, orsGeocodeBaseUrl } from './client';
import { homeLocation } from './config';
import {
  orsGeocodeResponseSchema,
  orsReverseResponseSchema,
  type Coord,
} from './types';

// Place-name → coordinates via the OpenRouteService Pelias geocoder. Lets the
// route builder accept natural-language locations ("Pariser Platz 1, Berlin",
// "Grunewald", "Limassol") instead of raw lat/lng.
//
// Scoping is by RADIUS, not by country. An earlier version pinned
// `boundary.country=DE`, which made every location outside Germany unresolvable
// — a route request while travelling died with "could not geocode location".
// But dropping the constraint entirely is worse: short local names are ambiguous
// worldwide, and a bare "Tiergarten" resolved to Tiergarten in AUSTRIA, yielding
// a 1,428 km "route". A focus point alone is only a ranking hint and did not
// prevent that.
//
// So: search a circle around the reference point first (nobody runs beyond it),
// and only if that finds nothing, retry worldwide. Local names stay
// unambiguous; genuinely distant places still resolve when you travel.
//
// Within the circle, the same street name can still exist several times —
// "Schloßstraße 1" is in both Steglitz and Charlottenburg, and taking Pelias's
// first hit was right only by luck (MZY-215). So we fetch a few hits and prefer
// the one whose Bezirk/Ortsteil/postcode the query itself names
// (`pickBestFeature`); with nothing to go on, Pelias's own order stands.
//
// That context score alone was not enough (MZY-219): "Club der Visionaere, Am
// Flutgraben, Alt-Treptow" picked "Der Wellness Club" in Treptow-Köpenick over
// Pelias's correct first hit, because "treptow" hit the wrong venue's borough
// while the right one — filed under Kreuzberg, with "Am Flutgraben" only in its
// `street` — scored nothing. So the hit's own NAME match now counts too, and its
// street is part of the context. And when the chosen hit still doesn't account
// for what the query names first, the result carries a `warning` the callers
// show, instead of silently routing somewhere else.

/**
 * Radius of the local-first search, in km. Comfortably larger than any run, so
 * every reachable waypoint is inside it, while still excluding same-named places
 * in other countries.
 */
const DEFAULT_RADIUS_KM = 75;

function radiusKm(): number {
  const raw = Number(process.env.ROUTING_GEOCODE_RADIUS_KM);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RADIUS_KM;
}

/**
 * Default reference point: the athlete's home. Falls back to no bias when
 * AGON_HOME_LAT/LNG aren't configured — an unbiased result beats a crash.
 */
function defaultFocus(): Coord | null {
  try {
    return homeLocation();
  } catch {
    return null;
  }
}

export interface GeocodeResult extends Coord {
  /** Human-readable label the geocoder matched, e.g. "Pariser Platz 1, Berlin". */
  label: string;
  /** Set when the hit may not be the place the query meant (see matchWarning). */
  warning?: string;
}

/**
 * Resolve a free-text location to its best coordinate match, or null if the
 * geocoder found nothing. `focus` biases relevance toward a point (default:
 * home); pass the current start point when routing away from home so waypoint
 * names resolve near where the run actually begins. Pass null for no bias.
 */
export async function geocode(
  text: string,
  focus?: Coord | null,
): Promise<GeocodeResult | null> {
  const bias = focus === undefined ? defaultFocus() : focus;
  // Local first (bounded circle), then worldwide. With no reference point there
  // is only one possible search.
  if (bias) {
    const near = await searchOnce(text, bias, radiusKm());
    if (near) return near;
  }
  return searchOnce(text, bias, null);
}

/** Hits fetched per search, to disambiguate between (see pickBestFeature). */
const CANDIDATE_HITS = 5;

type GeocodeFeature = ReturnType<
  typeof orsGeocodeResponseSchema.parse
>['features'][number];

/** Lower-cased, umlaut-transliterated words of ≥3 chars (or any digits). */
function tokens(s: string): string[] {
  return transliterateUmlauts(s)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 || /^\d+$/.test(t));
}

/**
 * Articles and prepositions: "Der Wellness Club" sharing "der" with "Club der
 * Visionaere" is no evidence it's the same place.
 */
const STOPWORDS = new Set([
  'der',
  'die',
  'das',
  'den',
  'dem',
  'des',
  'und',
  'von',
  'bei',
  'zum',
  'zur',
  'the',
  'and',
]);

function distinctive(s: string): string[] {
  return tokens(s).filter((t) => !STOPWORDS.has(t));
}

/** The hit's own name — or its label when Pelias gave no separate name. */
function ownName(f: GeocodeFeature): string {
  return f.properties.name ?? f.properties.label ?? '';
}

/** Where the hit is: its street plus the admin areas and postcode. */
function contextTokens(f: GeocodeFeature): Set<string> {
  const p = f.properties;
  return new Set(
    tokens(
      [
        p.street,
        p.neighbourhood,
        p.borough,
        p.locality,
        p.localadmin,
        p.county,
        p.postalcode,
      ]
        .filter(Boolean)
        .join(' '),
    ),
  );
}

/**
 * A query word in the hit's own NAME is stronger evidence than one in its area:
 * "Club der Visionäre, Alt-Treptow" must pick the Visionäre (club + visionaere)
 * over "Der Wellness Club" in Treptow (club + treptow). But not so strong that
 * one name word beats two area words — see pickBestFeature's Mauerpark case.
 */
const NAME_WEIGHT = 1.5;

/**
 * Pick the hit that best matches the query: NAME_WEIGHT per distinctive query
 * word found in the hit's own name, plus one per word found only in its context
 * (street, neighbourhood, borough, locality, postcode …). A street name shared
 * by every candidate scores them all equally, so the Bezirk decides. Additive,
 * so "Mauerpark, Prenzlauer Berg" still prefers the park (1 name + 2 context
 * words) over the Ortsteil named "Prenzlauer Berg" (2 name words). Highest
 * score wins; ties keep Pelias's relevance order. Pure; exported for tests.
 */
export function pickBestFeature(
  text: string,
  features: GeocodeFeature[],
): GeocodeFeature | undefined {
  const query = distinctive(text);
  let best: GeocodeFeature | undefined;
  let bestScore = -1;
  for (const f of features) {
    const own = new Set(tokens(ownName(f)));
    const context = contextTokens(f);
    let score = 0;
    for (const t of query) {
      if (own.has(t)) score += NAME_WEIGHT;
      else if (context.has(t)) score += 1;
    }
    if (score > bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}

/**
 * A warning when the hit doesn't account for what the query names FIRST (the
 * text before the first comma — the venue or street; the rest is usually just
 * where it is). A distinctive word there that appears nowhere in the hit's
 * name, street or area means Pelias matched something else, e.g. "Club der
 * Visionaere" → "Der Wellness Club". Null when every word is accounted for.
 * Pure; exported for tests.
 */
export function matchWarning(
  text: string,
  feature: GeocodeFeature,
): string | null {
  const head = distinctive(text.split(',')[0] ?? '');
  const known = new Set([
    ...tokens(ownName(feature)),
    ...tokens(feature.properties.label ?? ''),
    ...contextTokens(feature),
  ]);
  const missing = head.filter((t) => !known.has(t));
  if (missing.length === 0) return null;
  const label = feature.properties.label ?? ownName(feature);
  return (
    `"${text}" resolved to "${label}", which doesn't mention ` +
    `${missing.map((t) => `"${t}"`).join(', ')} — check it's the right place ` +
    '(a street address is more reliable).'
  );
}

/** One Pelias query. `restrictKm` bounds results to a circle around `bias`. */
async function searchOnce(
  text: string,
  bias: Coord | null,
  restrictKm: number | null,
): Promise<GeocodeResult | null> {
  const qs = new URLSearchParams({ text, size: String(CANDIDATE_HITS) });
  if (bias) {
    qs.set('focus.point.lon', String(bias.lng));
    qs.set('focus.point.lat', String(bias.lat));
    if (restrictKm !== null) {
      qs.set('boundary.circle.lon', String(bias.lng));
      qs.set('boundary.circle.lat', String(bias.lat));
      qs.set('boundary.circle.radius', String(restrictKm));
    }
  }
  const res = await orsFetch(
    `/geocode/search?${qs.toString()}`,
    undefined,
    orsGeocodeBaseUrl(),
  );
  const parsed = orsGeocodeResponseSchema.parse(await res.json());
  const feature = pickBestFeature(text, parsed.features);
  if (!feature) return null;
  const [lng, lat] = feature.geometry.coordinates;
  const warning = matchWarning(text, feature);
  return {
    lat,
    lng,
    label: feature.properties.label ?? text,
    ...(warning ? { warning } : {}),
  };
}

// Official German umlaut transliteration (DIN 5007-2 / passport style): the ASCII
// digraphs used when umlauts can't be shown. Applied to geocoded place names so
// they render consistently ("Schöneberg" → "Schoeneberg", "Köpenick" →
// "Koepenick", "Straße" → "Strasse").
const UMLAUT_MAP: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  Ä: 'Ae',
  Ö: 'Oe',
  Ü: 'Ue',
  ß: 'ss',
};

export function transliterateUmlauts(s: string): string {
  return s.replace(/[äöüÄÖÜß]/g, (c) => UMLAUT_MAP[c] ?? c);
}

/**
 * Normalise a geocoded area name for display: drop the administrative prefixes
 * `lang=de` adds ("Berlin-Schöneberg" → "Schöneberg", "Bezirk Neukölln" →
 * "Neukölln"), then apply the official umlaut transliteration.
 */
export function normalizePlaceName(raw: string): string {
  const stripped = raw
    .trim()
    .replace(/^Berlin[-\s]+/i, '')
    .replace(/^(Bezirk|Ortsteil)\s+/i, '')
    .trim();
  return transliterateUmlauts(stripped);
}

/**
 * Reverse-geocode a point to a short area name (neighbourhood → locality →
 * borough), or null if nothing recognizable is found. Used to describe which
 * parts of the city a route passes through. Prefers finer-grained names so a
 * Berlin loop reads "Tempelhof, Schoeneberg" rather than just "Berlin".
 * `lang=de` asks for German names (with umlauts) so the official transliteration
 * has something to normalise; names are returned in their ASCII digraph form.
 */
export async function reverseGeocode(coord: Coord): Promise<string | null> {
  const qs = new URLSearchParams({
    'point.lon': String(coord.lng),
    'point.lat': String(coord.lat),
    lang: 'de',
    size: '1',
    layers: 'neighbourhood,locality,borough,localadmin',
  });
  const res = await orsFetch(
    `/geocode/reverse?${qs.toString()}`,
    undefined,
    orsGeocodeBaseUrl(),
  );
  const parsed = orsReverseResponseSchema.parse(await res.json());
  const p = parsed.features[0]?.properties;
  if (!p) return null;
  const name =
    p.neighbourhood ??
    p.locality ??
    p.borough ??
    p.localadmin ??
    p.name ??
    null;
  return name === null ? null : normalizePlaceName(name);
}
