// Small, pure time helpers for converting a run's UTC start into the athlete's
// local date + time-of-day that the wellness / HR intraday endpoints key on.
//
// DST-correct by construction: these take an IANA time zone (e.g. 'Europe/Berlin',
// see ATHLETE_TIME_ZONE) and resolve the real UTC offset for each instant via the
// platform's Intl time-zone database — so CET↔CEST transitions are handled
// automatically. This replaced a fixed-offset design (a stale UTC−3 offset), which
// broke as soon as the athlete's real zone observed DST.

export interface LocalParts {
  date: string; // YYYY-MM-DD in athlete-local time
  hms: string; // HH:mm:ss in athlete-local time
  secondsOfDay: number; // seconds since local midnight
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock calendar/time fields of a UTC instant, as seen in `timeZone`. */
function zonedParts(ms: number, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  // Some engines render midnight as hour '24'; normalize to 0.
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/**
 * Offset (ms) that `timeZone` is ahead of UTC at instant `ms`
 * (local = utc + offset). Derived by comparing the zone's wall-clock to UTC.
 */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const asIfUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return asIfUtc - ms;
}

/** Local calendar parts of a UTC instant, in the given IANA time zone. */
export function athleteLocalParts(
  utcISO: string,
  timeZone: string,
): LocalParts {
  const ms = Date.parse(utcISO);
  if (Number.isNaN(ms)) {
    throw new Error(`athleteLocalParts: invalid instant '${utcISO}'`);
  }
  const p = zonedParts(ms, timeZone);
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    hms: `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`,
    secondsOfDay: p.hour * 3600 + p.minute * 60 + p.second,
  };
}

/**
 * Turn an athlete-local naive timestamp (no zone, e.g. Fitbit's
 * '2026-08-01T23:30:00.000') into a UTC ISO instant, interpreting the wall-clock
 * in `timeZone`. DST-aware: the offset is resolved for that instant, then refined
 * once so a guess that started on the wrong side of a transition self-corrects.
 */
export function athleteLocalToUtcISO(
  localNaiveISO: string,
  timeZone: string,
): string {
  const naiveMs = Date.parse(
    localNaiveISO.endsWith('Z') ? localNaiveISO : `${localNaiveISO}Z`,
  );
  if (Number.isNaN(naiveMs)) {
    throw new Error(
      `athleteLocalToUtcISO: invalid timestamp '${localNaiveISO}'`,
    );
  }
  // naiveMs treats the wall-clock as if UTC. Subtract the zone offset to get the
  // true instant; refine once around DST boundaries.
  let offset = zoneOffsetMs(naiveMs, timeZone);
  offset = zoneOffsetMs(naiveMs - offset, timeZone);
  return new Date(naiveMs - offset).toISOString();
}

/** Parse an "HH:mm:ss" (or "HH:mm") clock string to seconds since midnight. */
export function hmsToSecondsOfDay(hms: string): number {
  const parts = hms.split(':').map(Number);
  const [h, m, s = 0] = parts;
  if (
    parts.length < 2 ||
    [h, m, s].some((v) => v === undefined || Number.isNaN(v))
  ) {
    throw new Error(`hmsToSecondsOfDay: invalid time '${hms}'`);
  }
  return (h as number) * 3600 + (m as number) * 60 + (s as number);
}

/**
 * The athlete-local calendar date a write belongs to (MZY-205). An explicit
 * date from the form always wins; otherwise the date the athlete ACTED on
 * (`capturedAt`, the device clock), and only for legacy callers that send
 * neither, the processing instant `nowISO`. Never prefer "now" over a
 * captured time — a write synced the next morning must not move to that day.
 */
export function captureDate(
  explicitDate: string | undefined,
  capturedAt: string | undefined,
  timeZone: string,
  nowISO: string,
): string {
  if (explicitDate) return explicitDate;
  return athleteLocalParts(capturedAt ?? nowISO, timeZone).date;
}
