import { query } from '@/services/db';
import { streamSensors } from '@/services/marts/streamSensors';
import { getOpenSuggestionFor } from '@/services/missedStops';
import type { StopSuggestionView } from '@/lib/missedStopDetection';
import type { RelativeEffortMethod, RunDetail, RunListItem, RunStream } from '@/lib/marts';
import { computeMovingTime, estimateNetTime } from '@/lib/movingTime';

// Read side of the recent-runs / run-detail view. Unlike the other Phase 3
// views, this reads the OPERATIONAL `runs`/`run_streams` tables directly, not
// a dbt mart — a run list is current-state browsing, not a derived time
// series (same reasoning CLAUDE.md gives for the nutrition/general-health
// views). Relative Effort is the one derived number, joined from the
// operational public.run_relative_effort (the same score fct_relative_effort
// passes through) so a hand correction's re-score shows at once instead of
// after the next dbt build (MZY-253). Numerics are cast to float in SQL (pg
// returns `numeric`/`numeric[]` as strings); dates are rendered as plain
// YYYY-MM-DD strings to avoid timezone drift.

// A GPS/HR stream can run to ~10k samples (CLAUDE.md: up to 10.5k points on
// the richest Strava-enriched runs). The PWA route/HR chart doesn't need
// per-second resolution, so the detail read downsamples server-side — keeps
// the response small and the inline-SVG render cheap.
const MAX_STREAM_POINTS = 500;

function downsample<T>(values: T[], maxPoints: number): T[] {
  if (values.length <= maxPoints) return values;
  const stride = Math.ceil(values.length / maxPoints);
  const out: T[] = [];
  for (let i = 0; i < values.length; i += stride) out.push(values[i]!);
  return out;
}

interface ListRow {
  id: string;
  date: string;
  distance_km: number | null;
  duration_s: number | null;
  avg_pace_s_per_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  temp_c: number | null;
  weather_conditions: string | null;
  relative_effort: number | null;
  has_route: boolean;
  corrected: boolean;
}

/** Most recent `limit` runs, most-recent first. */
export async function listRuns(limit: number): Promise<RunListItem[]> {
  const { rows } = await query<ListRow>(
    `
    select
      r.id::text                        as id,
      to_char(r.date, 'YYYY-MM-DD')     as date,
      r.distance_km::float8             as distance_km,
      r.duration_s,
      r.avg_pace_s_per_km::float8       as avg_pace_s_per_km,
      r.avg_hr,
      r.max_hr,
      r.temp_c::float8                  as temp_c,
      r.weather_conditions,
      rre.score::float8                 as relative_effort,
      exists(
        select 1 from run_streams rs where rs.run_id = r.id and rs.lat is not null
      )                                  as has_route,
      cardinality(r.corrected_fields) > 0 as corrected
    from runs r
    left join run_relative_effort rre on rre.run_id = r.id
    order by r.date desc, r.started_at desc nulls last, r.id
    limit $1::int
    `,
    [limit],
  );

  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    distanceKm: r.distance_km,
    durationS: r.duration_s,
    avgPaceSPerKm: r.avg_pace_s_per_km,
    avgHr: r.avg_hr,
    maxHr: r.max_hr,
    tempC: r.temp_c,
    weatherConditions: r.weather_conditions,
    relativeEffort: r.relative_effort,
    hasRoute: r.has_route,
    corrected: r.corrected,
  }));
}

interface DetailRow {
  id: string;
  date: string;
  block: number | null;
  week: number | null;
  distance_km: number | null;
  duration_s: number | null;
  avg_pace_s_per_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  elevation_gain_m: number | null;
  shoe_used: string | null;
  perceived_effort: number | null;
  pain_location: string | null;
  pain_onset_km: number | null;
  general_notes: string | null;
  temp_c: number | null;
  humidity_pct: number | null;
  wind_kph: number | null;
  weather_conditions: string | null;
  source: string | null;
  relative_effort: number | null;
  relative_effort_method: RelativeEffortMethod | null;
  corrected_fields: string[];
  started_at: string | null;
  source_started_at: string | null;
}

interface StreamRow {
  source: string;
  time_s: (number | null)[] | null;
  heartrate: (number | null)[] | null;
  distance_m: (number | null)[] | null;
  altitude_m: (number | null)[] | null;
  lat: (number | null)[] | null;
  lng: (number | null)[] | null;
  moving: (boolean | null)[] | null;
  derived_moving: (boolean | null)[] | null;
}

/** One run's full detail: run row + Relative Effort + its best available stream. */
export async function getRunDetail(id: string): Promise<RunDetail | null> {
  const { rows } = await query<DetailRow>(
    `
    select
      r.id::text                        as id,
      to_char(r.date, 'YYYY-MM-DD')     as date,
      r.block,
      r.week,
      r.distance_km::float8             as distance_km,
      r.duration_s,
      r.avg_pace_s_per_km::float8       as avg_pace_s_per_km,
      r.avg_hr,
      r.max_hr,
      r.elevation_gain_m::float8        as elevation_gain_m,
      r.shoe_used,
      r.perceived_effort,
      r.pain_location,
      r.pain_onset_km::float8           as pain_onset_km,
      r.general_notes,
      r.temp_c::float8                  as temp_c,
      r.humidity_pct::float8            as humidity_pct,
      r.wind_kph::float8                as wind_kph,
      r.weather_conditions,
      r.source,
      rre.score::float8                 as relative_effort,
      rre.method                        as relative_effort_method,
      r.corrected_fields,
      to_json(r.started_at)#>>'{}'      as started_at,
      to_json(r.source_started_at)#>>'{}' as source_started_at
    from runs r
    left join run_relative_effort rre on rre.run_id = r.id
    where r.id = $1::uuid
    `,
    [id],
  );
  const row = rows[0];
  if (!row) return null;

  // Prefer the stream carrying a GPS route (Strava enrichment); fall back to
  // whichever source has HR only (Fitbit) so route-less runs still chart HR.
  const { rows: streamRows } = await query<StreamRow>(
    `
    select source, time_s, heartrate, moving, derived_moving,
           distance_m::float8[] as distance_m,
           altitude_m::float8[] as altitude_m,
           lat::float8[]        as lat,
           lng::float8[]        as lng
    from run_streams
    where run_id = $1::uuid
    order by (lat is not null) desc, source
    limit 1
    `,
    [id],
  );
  const streamRow = streamRows[0];
  const stream: RunStream | null = streamRow
    ? {
        source: streamRow.source,
        timeS: downsample(streamRow.time_s ?? [], MAX_STREAM_POINTS),
        heartrate: downsample(streamRow.heartrate ?? [], MAX_STREAM_POINTS),
        distanceM: downsample(streamRow.distance_m ?? [], MAX_STREAM_POINTS),
        altitudeM: downsample(streamRow.altitude_m ?? [], MAX_STREAM_POINTS),
        lat: downsample(streamRow.lat ?? [], MAX_STREAM_POINTS),
        lng: downsample(streamRow.lng ?? [], MAX_STREAM_POINTS),
      }
    : null;

  // Moving-vs-paused (forced stops, e.g. red lights) from the FULL stream —
  // computed before downsampling loses precision. Prefer Strava's real
  // `moving`; fall back to the in-house derived_moving (lib/movingTime.ts::
  // deriveMovingFlags, calibrated F1 0.98 against Strava ground truth) for
  // sources that never carry the real flag (Google Health, file imports).
  const fullTimeS = streamRow?.time_s?.map(Number) ?? null;
  const movingFlags = streamRow?.moving ?? streamRow?.derived_moving ?? null;
  const movingFlagSource: 'strava' | 'derived' | null = streamRow?.moving
    ? 'strava'
    : streamRow?.derived_moving
      ? 'derived'
      : null;
  const movingTime =
    movingFlags && fullTimeS ? computeMovingTime(fullTimeS, movingFlags) : null;
  const netTime =
    movingFlags && fullTimeS && streamRow?.distance_m
      ? estimateNetTime(fullTimeS, streamRow.distance_m.map(Number), movingFlags)
      : null;
  const netPaceSPerKm =
    netTime && row.distance_km != null && row.distance_km > 0
      ? netTime.netTimeS / row.distance_km
      : null;

  return {
    id: row.id,
    date: row.date,
    block: row.block,
    week: row.week,
    distanceKm: row.distance_km,
    durationS: row.duration_s,
    avgPaceSPerKm: row.avg_pace_s_per_km,
    avgHr: row.avg_hr,
    maxHr: row.max_hr,
    elevationGainM: row.elevation_gain_m,
    shoeUsed: row.shoe_used,
    perceivedEffort: row.perceived_effort,
    painLocation: row.pain_location,
    painOnsetKm: row.pain_onset_km,
    generalNotes: row.general_notes,
    tempC: row.temp_c,
    humidityPct: row.humidity_pct,
    windKph: row.wind_kph,
    weatherConditions: row.weather_conditions,
    source: row.source,
    relativeEffort: row.relative_effort,
    relativeEffortMethod: row.relative_effort_method,
    movingTimeS: movingTime?.movingTimeS ?? null,
    pausedTimeS: movingTime?.pausedTimeS ?? null,
    movingFlagSource,
    estimatedNetTimeS: netTime?.netTimeS ?? null,
    estimatedNetPaceSPerKm: netPaceSPerKm,
    netTimeStopsCounted: netTime?.stopsCounted ?? null,
    stopSuggestion: await openStopSuggestion(row.id),
    correction: {
      correctedFields: row.corrected_fields,
      startedAt: row.started_at,
      sourceStartedAt: row.source_started_at,
    },
    sensors: await streamSensors('run', row.id),
    stream,
  };
}

/** The activity's open missed-stop suggestion (MZY-254), trimmed for the page. */
async function openStopSuggestion(id: string): Promise<StopSuggestionView | null> {
  const s = await getOpenSuggestionFor('run', id);
  return s
    ? {
        id: s.id,
        shortId: s.shortId,
        confidence: s.confidence,
        trimS: s.trimS,
        distanceKm: s.distanceKm,
        movingS: s.movingS,
      }
    : null;
}
