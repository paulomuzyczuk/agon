import { query } from '@/services/db';
import { streamSensors } from '@/services/marts/streamSensors';
import { getOpenSuggestionFor } from '@/services/missedStops';
import type { StopSuggestionView } from '@/lib/missedStopDetection';
import type {
  RideDetail,
  RideListItem,
  RideMeasuredPower,
  RidePower,
  RideStream,
} from '@/lib/rideMarts';
import type { PowerSource } from '@/lib/types';

// Read side of the recent-rides / ride-detail view. Mirrors
// services/marts/runs.ts — reads the OPERATIONAL `rides`/`ride_streams`
// tables directly (a ride list is current-state browsing, not a derived time
// series), not a dbt mart. Relative Effort is the one derived number, so
// getRideDetail alone joins it in from the operational
// public.ride_relative_effort (same shape as runs.ts — current after a hand
// correction's re-score, MZY-253), plus the measured-power metrics + curve
// (public.ride_power_metrics / ride_power_curve, MZY-269). Numerics are cast to float in SQL; dates are
// rendered as plain YYYY-MM-DD strings to avoid timezone drift.

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
  avg_speed_kmh: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  temp_c: number | null;
  weather_conditions: string | null;
  has_route: boolean;
  corrected: boolean;
}

/** Most recent `limit` rides, most-recent first. */
export async function listRides(limit: number): Promise<RideListItem[]> {
  const { rows } = await query<ListRow>(
    `
    select
      r.id::text                        as id,
      to_char(r.date, 'YYYY-MM-DD')     as date,
      r.distance_km::float8             as distance_km,
      r.duration_s,
      r.avg_speed_kmh::float8           as avg_speed_kmh,
      r.avg_hr,
      r.max_hr,
      r.temp_c::float8                  as temp_c,
      r.weather_conditions,
      exists(
        select 1 from ride_streams rs where rs.ride_id = r.id and rs.lat is not null
      )                                  as has_route,
      cardinality(r.corrected_fields) > 0 as corrected
    from rides r
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
    avgSpeedKmh: r.avg_speed_kmh,
    avgHr: r.avg_hr,
    maxHr: r.max_hr,
    tempC: r.temp_c,
    weatherConditions: r.weather_conditions,
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
  avg_speed_kmh: number | null;
  max_speed_kmh: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  elevation_gain_m: number | null;
  bike_used: string | null;
  perceived_effort: number | null;
  general_notes: string | null;
  temp_c: number | null;
  humidity_pct: number | null;
  wind_kph: number | null;
  weather_conditions: string | null;
  source: string | null;
  relative_effort: number | null;
  relative_effort_method: 'stream' | 'average' | null;
  avg_power_w: number | null;
  max_power_w: number | null;
  weighted_avg_power_w: number | null;
  kilojoules: number | null;
  power_source: PowerSource | null;
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
}

/** One ride's full detail: ride row + its best available stream. */
export async function getRideDetail(id: string): Promise<RideDetail | null> {
  const { rows } = await query<DetailRow>(
    `
    select
      r.id::text                        as id,
      to_char(r.date, 'YYYY-MM-DD')     as date,
      r.block,
      r.week,
      r.distance_km::float8             as distance_km,
      r.duration_s,
      r.avg_speed_kmh::float8           as avg_speed_kmh,
      r.max_speed_kmh::float8           as max_speed_kmh,
      r.avg_hr,
      r.max_hr,
      r.elevation_gain_m::float8        as elevation_gain_m,
      r.bike_used,
      r.perceived_effort,
      r.general_notes,
      r.temp_c::float8                  as temp_c,
      r.humidity_pct::float8            as humidity_pct,
      r.wind_kph::float8                as wind_kph,
      r.weather_conditions,
      r.source,
      rre.score::float8                 as relative_effort,
      rre.method                        as relative_effort_method,
      r.avg_power_w,
      r.max_power_w,
      r.weighted_avg_power_w,
      r.kilojoules::float8              as kilojoules,
      r.power_source,
      r.corrected_fields,
      to_json(r.started_at)#>>'{}'      as started_at,
      to_json(r.source_started_at)#>>'{}' as source_started_at
    from rides r
    left join ride_relative_effort rre on rre.ride_id = r.id
    where r.id = $1::uuid
    `,
    [id],
  );
  const row = rows[0];
  if (!row) return null;

  // Prefer the stream carrying a GPS route; fall back to HR-only. Mirrors
  // services/marts/runs.ts getRunDetail.
  const { rows: streamRows } = await query<StreamRow>(
    `
    select source, time_s, heartrate,
           distance_m::float8[] as distance_m,
           altitude_m::float8[] as altitude_m,
           lat::float8[]        as lat,
           lng::float8[]        as lng
    from ride_streams
    where ride_id = $1::uuid
    order by (lat is not null) desc, source
    limit 1
    `,
    [id],
  );
  const streamRow = streamRows[0];
  const stream: RideStream | null = streamRow
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

  return {
    id: row.id,
    date: row.date,
    block: row.block,
    week: row.week,
    distanceKm: row.distance_km,
    durationS: row.duration_s,
    avgSpeedKmh: row.avg_speed_kmh,
    maxSpeedKmh: row.max_speed_kmh,
    avgHr: row.avg_hr,
    maxHr: row.max_hr,
    elevationGainM: row.elevation_gain_m,
    bikeUsed: row.bike_used,
    perceivedEffort: row.perceived_effort,
    generalNotes: row.general_notes,
    tempC: row.temp_c,
    humidityPct: row.humidity_pct,
    windKph: row.wind_kph,
    weatherConditions: row.weather_conditions,
    source: row.source,
    relativeEffort: row.relative_effort,
    relativeEffortMethod: row.relative_effort_method,
    power: ridePower(row),
    measuredPower: await measuredPower(row.id),
    stopSuggestion: await openStopSuggestion(row.id),
    correction: {
      correctedFields: row.corrected_fields,
      startedAt: row.started_at,
      sourceStartedAt: row.source_started_at,
    },
    sensors: await streamSensors('ride', row.id),
    stream,
  };
}

/** The ride's power with its provenance, or null when it has none (MZY-267). */
function ridePower(row: DetailRow): RidePower | null {
  if (row.power_source === null) return null;
  return {
    avgW: row.avg_power_w,
    maxW: row.max_power_w,
    weightedW: row.weighted_avg_power_w,
    kj: row.kilojoules,
    source: row.power_source,
  };
}

/** NP/IF/TSS + curve from the ride's device stream (MZY-269), or null. */
async function measuredPower(id: string): Promise<RideMeasuredPower | null> {
  const { rows } = await query<{
    np_w: number;
    intensity_factor: number | null;
    tss: number | null;
    ftp_w: number | null;
    stream_source: string;
  }>(
    `select np_w, intensity_factor::float8 as intensity_factor,
            tss::float8 as tss, ftp_w, stream_source
       from ride_power_metrics where ride_id = $1::uuid`,
    [id],
  );
  const m = rows[0];
  if (!m) return null;
  const { rows: curve } = await query<{ duration_s: number; watts: number }>(
    `select duration_s, watts from ride_power_curve
      where ride_id = $1::uuid order by duration_s`,
    [id],
  );
  return {
    npW: m.np_w,
    intensityFactor: m.intensity_factor,
    tss: m.tss,
    ftpW: m.ftp_w,
    streamSource: m.stream_source,
    curve: curve.map((c) => ({ durationS: c.duration_s, watts: c.watts })),
  };
}

/** The activity's open missed-stop suggestion (MZY-254), trimmed for the page. */
async function openStopSuggestion(
  id: string,
): Promise<StopSuggestionView | null> {
  const s = await getOpenSuggestionFor('ride', id);
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
