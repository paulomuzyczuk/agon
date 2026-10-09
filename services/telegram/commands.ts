import { z } from 'zod';
import type { HillPreference, RouteProfile } from '../routing/types';

// Pure parsing + validation of the Telegram text commands (CLAUDE.md "Telegram
// Bot Commands"). No I/O — this turns a raw message string into a typed,
// validated command or throws a user-facing CommandError. The DB execution lives
// in handlers.ts, so this layer is unit-testable with no database. Transport-thin:
// the webhook route (deployment layer) only forwards message text here.

/** A parse/validation failure whose message is safe to reply to the user with. */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

export type ParsedCommand =
  | { kind: 'weight'; weightKg: number }
  | { kind: 'bf'; bodyFatPct: number }
  | { kind: 'sweat'; preKg: number; postKg: number; fluidL: number }
  | { kind: 'week' }
  | { kind: 'sync' }
  | { kind: 'undo' }
  | {
      kind: 'route';
      targetKm: number;
      through: string[];
      finishNear: string | null;
      /** 'today' | 'tomorrow' | 'YYYY-MM-DD' — resolved to a date in the handler. */
      day: string;
      /** Travel mode. Default 'foot-walking' (existing behaviour). */
      profile: RouteProfile;
      /** Gradient preference — bike routes only. Absent: the engine's default. */
      hills?: HillPreference;
    }
  | {
      /** A missed-stop suggestion (MZY-254): /trim_<n> applies, /keep_<n> dismisses. */
      kind: 'stop';
      action: 'apply' | 'dismiss';
      shortId: number;
    }
  | {
      kind: 'maintained';
      taskKey: string;
      /** Bike name as typed ("on <bike>"); null → the one active bike. */
      bikeName: string | null;
    };

// Plausibility bounds — catch a fat-fingered "/weight 862" before it hits the DB.
const weightKg = z.number().positive().max(400);
const bodyFatPct = z.number().min(1).max(75);
const bodyKg = z.number().positive().max(400);
const fluidL = z.number().min(0).max(10);
const routeKm = z.number().positive().max(100);

function num(raw: string, label: string): number {
  const n = Number(raw);
  if (raw.trim() === '' || Number.isNaN(n)) {
    throw new CommandError(`${label} must be a number (got "${raw}")`);
  }
  return n;
}

function check<T>(schema: z.ZodType<T>, value: T, label: string): T {
  const res = schema.safeParse(value);
  if (!res.success) {
    throw new CommandError(`${label} is out of range (got ${value})`);
  }
  return res.data;
}

/**
 * Parse a message like "/weight 86.2" into a typed command. Tolerates a
 * "@botname" suffix on the command and extra whitespace. Throws CommandError with
 * a user-facing message on anything malformed.
 */
export function parseCommand(text: string): ParsedCommand {
  const tokens = text.trim().split(/\s+/);
  const head = tokens[0] ?? '';
  if (!head.startsWith('/')) {
    throw new CommandError('Not a command — messages must start with "/".');
  }
  const name = head.slice(1).split('@')[0]!.toLowerCase();
  const args = tokens.slice(1);

  // /trim_7 and /keep_7 (tap-to-send links in the missed-stop nudge), or the
  // typed /trim 7 · /keep 7.
  const stop = /^(trim|keep)(?:_(\d+))?$/.exec(name);
  if (stop) {
    const raw = stop[2] ?? args[0];
    const shortId = raw != null && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (
      !Number.isSafeInteger(shortId) ||
      shortId <= 0 ||
      (stop[2] && args.length > 0)
    ) {
      throw new CommandError(
        `Usage: /${stop[1]}_<n> — the number from the missed-stop message, e.g. /${stop[1]}_7`,
      );
    }
    return {
      kind: 'stop',
      action: stop[1] === 'trim' ? 'apply' : 'dismiss',
      shortId,
    };
  }

  switch (name) {
    case 'weight': {
      if (args.length !== 1) {
        throw new CommandError('Usage: /weight <kg>  e.g. /weight 86.2');
      }
      return {
        kind: 'weight',
        weightKg: check(weightKg, num(args[0]!, 'weight'), 'weight'),
      };
    }
    case 'bf': {
      if (args.length !== 1) {
        throw new CommandError('Usage: /bf <percent>  e.g. /bf 16.8');
      }
      return {
        kind: 'bf',
        bodyFatPct: check(
          bodyFatPct,
          num(args[0]!, 'body fat %'),
          'body fat %',
        ),
      };
    }
    case 'sweat': {
      if (args.length !== 3) {
        throw new CommandError(
          'Usage: /sweat <pre-kg> <post-kg> <fluid-L>  e.g. /sweat 86.4 85.8 0.5',
        );
      }
      const pre = check(bodyKg, num(args[0]!, 'pre-weight'), 'pre-weight');
      const post = check(bodyKg, num(args[1]!, 'post-weight'), 'post-weight');
      const fluid = check(fluidL, num(args[2]!, 'fluid'), 'fluid');
      if (post > pre + fluid) {
        throw new CommandError(
          'post-weight exceeds pre-weight + fluid — check the numbers',
        );
      }
      return { kind: 'sweat', preKg: pre, postKg: post, fluidL: fluid };
    }
    case 'week':
      return { kind: 'week' };
    case 'sync':
      return { kind: 'sync' };
    case 'undo':
      return { kind: 'undo' };
    case 'route':
      // Free-text after the command, preserving commas/case for place names.
      return parseRoute(text.trim().replace(/^\/\S+\s*/, ''));
    case 'maintained': {
      if (args.length === 0) {
        throw new CommandError(MAINTAINED_USAGE);
      }
      // "<task> on <bike>" — the bike is only needed with several active bikes
      // (MZY-66). Split at the first "on" token: no catalog task name has one.
      const onIdx = args.findIndex((a) => a.toLowerCase() === 'on');
      const taskText = (onIdx === -1 ? args : args.slice(0, onIdx)).join(' ');
      const bikeText = onIdx === -1 ? null : args.slice(onIdx + 1).join(' ');
      if (!taskText || bikeText === '') {
        throw new CommandError(MAINTAINED_USAGE);
      }
      // Normalize free text ("chain lube") to a catalog-style key
      // ("chain-lube") — the actual match against public.gear_maintenance_tasks
      // (and of the bike name against public.gear) happens in the handler,
      // since this layer stays DB-free.
      const taskKey = taskText.toLowerCase().replace(/\s+/g, '-');
      return { kind: 'maintained', taskKey, bikeName: bikeText };
    }
    default:
      throw new CommandError(`Unknown command "/${name}".`);
  }
}

const MAINTAINED_USAGE =
  'Usage: /maintained <task> [on <bike>]  e.g. /maintained chain-lube on Grail';

const ROUTE_USAGE =
  'Usage: /route <km> [through <place; place>] [finish <place>] [bike [road|gravel] [flat|hilly]] [today|tomorrow|YYYY-MM-DD]\n' +
  'e.g. /route 25 through Tiergarten finish Alexanderplatz tomorrow\n' +
  'e.g. /route 40 bike finish Grunewald  (cycling loop; default is running)\n' +
  'e.g. /route 60 road bike flat';

// Keyword(s) that switch the route mode from the default running loop to a
// cycling one. A word-boundary alternation, reused both as a standalone test
// and inlined into the place-clause STOP boundary below.
const BIKE_KEYWORDS_SRC = String.raw`(?:bike|biking|cycle|cycling|ride|riding|mtb)\b`;
const BIKE_KEYWORDS = new RegExp(`\\b${BIKE_KEYWORDS_SRC}`, 'i');

// Cycling preferences (MZY-67), mapped onto what ORS actually offers: surface
// is chosen by the cycling profile itself (ORS has no surface parameter), hills
// by the `steepness_difficulty` weighting. Surface words only count in bike
// mode — "road" is too common a word to force a running request onto a bike.
const ROAD_KEYWORDS_SRC = String.raw`(?:road|paved|tarmac|asphalt)\b`;
const GRAVEL_KEYWORDS_SRC = String.raw`(?:gravel|mtb|off-?road|unpaved)\b`;
// "no hills" / "avoid hills" must be tried before the bare "hills" of HILLY.
const FLAT_KEYWORDS_SRC = String.raw`(?:flat|(?:no|avoid(?:ing)?)\s+hills)\b`;
const HILLY_KEYWORDS_SRC = String.raw`(?:hilly|hills|climbs?|climbing)\b`;

function cyclingProfile(rest: string): RouteProfile {
  if (new RegExp(`\\b${GRAVEL_KEYWORDS_SRC}`, 'i').test(rest)) {
    return 'cycling-mountain';
  }
  if (new RegExp(`\\b${ROAD_KEYWORDS_SRC}`, 'i').test(rest)) {
    return 'cycling-road';
  }
  return 'cycling-regular';
}

function hillPreference(rest: string): HillPreference | undefined {
  if (new RegExp(`\\b${FLAT_KEYWORDS_SRC}`, 'i').test(rest)) return 'flat';
  if (new RegExp(`\\b${HILLY_KEYWORDS_SRC}`, 'i').test(rest)) return 'hilly';
  return undefined;
}

// Split a "through" clause into individual place names. Semicolons separate
// waypoints (so a name may contain a comma); " and " is also accepted.
function splitPlaces(segment: string): string[] {
  return segment
    .split(/\s*;\s*|\s+and\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse the free-text of a /route request into a typed command. Forgiving of word
 * order ("through" / "finish" may appear in either order) and phrasing
 * ("finishing near", "ending near"). Throws CommandError with usage on anything
 * it can't make sense of.
 */
export function parseRoute(rest: string): ParsedCommand {
  if (!rest.trim()) throw new CommandError(ROUTE_USAGE);

  const kmMatch = rest.match(/(\d+(?:[.,]\d+)?)\s*(?:km|k)?\b/i);
  if (!kmMatch) {
    throw new CommandError(`No distance found. ${ROUTE_USAGE}`);
  }
  const targetKm = check(
    routeKm,
    Number(kmMatch[1]!.replace(',', '.')),
    'distance',
  );

  const day =
    rest.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] ??
    rest.match(/\b(today|tomorrow)\b/i)?.[1]?.toLowerCase() ??
    'today';

  const bike = BIKE_KEYWORDS.test(rest);
  const profile: RouteProfile = bike ? cyclingProfile(rest) : 'foot-walking';
  const hills = hillPreference(rest);
  if (hills && !bike) {
    throw new CommandError(
      'Hill preferences (flat/hilly) only apply to bike routes — add "bike".',
    );
  }

  // A place clause runs until the next keyword (the other clause / a date / a
  // mode or preference keyword / end). Surface words only end a place in bike
  // mode, so a running request's place name may still contain "road".
  const prefs = [FLAT_KEYWORDS_SRC, HILLY_KEYWORDS_SRC];
  if (bike) prefs.push(ROAD_KEYWORDS_SRC, GRAVEL_KEYWORDS_SRC);
  const prefStop = prefs.map((p) => String.raw`|\s+${p}`).join('');
  const STOP = String.raw`(?=\s+through\b|\s+finish|\s+ending\b|\s+today\b|\s+tomorrow\b|\s+\d{4}-\d{2}-\d{2}\b|\s+${BIKE_KEYWORDS_SRC}${prefStop}|$)`;
  const throughSeg = rest.match(new RegExp(`\\bthrough\\s+(.+?)${STOP}`, 'i'));
  const finishSeg = rest.match(
    new RegExp(
      `\\b(?:finish(?:ing)?|ending)\\s+(?:near\\s+)?(.+?)${STOP}`,
      'i',
    ),
  );

  const through = throughSeg ? splitPlaces(throughSeg[1]!) : [];
  const finishNear = finishSeg ? finishSeg[1]!.trim() || null : null;
  if (through.length > 6) {
    throw new CommandError('Too many "through" waypoints (max 6).');
  }

  return {
    kind: 'route',
    targetKm,
    through,
    finishNear,
    day,
    profile,
    ...(hills ? { hills } : {}),
  };
}
