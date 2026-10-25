import type { PoolClient } from 'pg';
import { query, withTransaction } from './db';
import {
  correctRide,
  correctRun,
  revertCorrections,
  type Queryable,
} from './activityCorrections';
import { insertQualitativeLog } from './qualitativeLogs';
import {
  recomputeDerivedForActivity,
  type DerivedRecomputeResult,
} from './activityDerived';
import { getAthleteProfile } from '../lib/athleteProfile';
import { athleteLocalParts } from '../lib/time';
import { computeBlockWeek } from '../lib/training/trainingBlocks';
import {
  avgPaceSPerKm,
  avgSpeedKmh,
  fmtDurationS,
  planCorrection,
  revertGroupFields,
  type CorrectionActivityKind,
  type CorrectionPreview,
  type CorrectionRequest,
  type CorrectionStream,
  type RevertGroup,
} from '../lib/activityCorrection';

// Hand corrections of a run or ride from the PWA (MZY-253). The math is pure
// (lib/activityCorrection.ts); this module reads the activity + its stream,
// then in ONE transaction:
//   * writes the new totals (and a moved start) through correctRun/
//     correctRide, so every edited column lands in corrected_fields and
//     survives a source re-sync (MZY-252),
//   * cuts every stored stream of the activity on a late-stop trim (a stored
//     stream is never re-fetched, so the cut is durable),
//   * appends a provenance line per correction to general_notes and inserts
//     a qualitative_logs row (parsed_json.source = 'manual_correction') — the
//     shape of the hand-made 2026-09-29 fixes.
// After commit, the derived rows are refreshed (services/activityDerived.ts).

interface KindConfig {
  table: 'runs' | 'rides';
  streams: 'run_streams' | 'ride_streams';
  fk: 'run_id' | 'ride_id';
  /** Index-aligned array columns, all cut together on a trim. */
  arrays: readonly string[];
  idKey: 'runId' | 'rideId';
}

const SHARED_ARRAYS = [
  'time_s',
  'heartrate',
  'distance_m',
  'altitude_m',
  'cadence',
  'velocity_smooth_mps',
  'moving',
  'lat',
  'lng',
] as const;

const KINDS: Record<CorrectionActivityKind, KindConfig> = {
  run: {
    table: 'runs',
    streams: 'run_streams',
    fk: 'run_id',
    arrays: [
      ...SHARED_ARRAYS,
      'derived_moving',
      'fitbit_cadence',
      'heartrate_source_device',
    ],
    idKey: 'runId',
  },
  ride: {
    table: 'rides',
    streams: 'ride_streams',
    fk: 'ride_id',
    arrays: [
      ...SHARED_ARRAYS,
      'watts',
      // Live recordings (MZY-271): *_source_device must stay as long as time_s
      // (ride_streams_source_device_aligned), or the whole cut is rejected.
      'heartrate_source_device',
      'cadence_source_device',
      'velocity_source_device',
      'watts_source_device',
    ],
    idKey: 'rideId',
  },
};

export class ActivityNotFoundError extends Error {}

interface ActivityRow {
  id: string;
  date: string;
  startedAt: string | null;
  distanceKm: number;
  durationS: number;
  source: string;
  stravaActivityId: string | null;
}

async function loadActivity(
  kind: CorrectionActivityKind,
  id: string,
  db: Queryable,
  forUpdate: boolean,
): Promise<ActivityRow> {
  const k = KINDS[kind];
  const strava =
    kind === 'run'
      ? `COALESCE(strava_activity_id::text,
                  CASE WHEN source = 'strava' THEN external_id END)`
      : `CASE WHEN source = 'strava' THEN external_id END`;
  const { rows } = await db.query<{
    id: string;
    date: string;
    started_at: Date | null;
    distance_km: string | null;
    duration_s: number | null;
    source: string;
    strava_activity_id: string | null;
  }>(
    `SELECT id, date::text AS date, started_at, distance_km, duration_s, source,
            ${strava} AS strava_activity_id
       FROM public.${k.table} WHERE id = $1
       ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id],
  );
  const r = rows[0];
  if (!r) throw new ActivityNotFoundError(`${kind} ${id} not found`);
  return {
    id: r.id,
    date: r.date,
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    distanceKm: Number(r.distance_km ?? 0),
    durationS: r.duration_s ?? 0,
    source: r.source,
    stravaActivityId: r.strava_activity_id,
  };
}

/**
 * The stream the corrections read: prefer one with distance AND moving flags
 * (the first-km moving pace), then any with distance, then the longest.
 */
async function loadPrimaryStream(
  kind: CorrectionActivityKind,
  id: string,
  db: Queryable,
): Promise<CorrectionStream | null> {
  const k = KINDS[kind];
  const { rows } = await db.query<{
    time_s: number[];
    distance_m: number[] | null;
    moving: boolean[] | null;
  }>(
    `SELECT time_s, distance_m::float8[] AS distance_m, moving
       FROM public.${k.streams}
      WHERE ${k.fk} = $1
      ORDER BY (distance_m IS NOT NULL AND moving IS NOT NULL) DESC,
               (distance_m IS NOT NULL) DESC, sample_count DESC, source
      LIMIT 1`,
    [id],
  );
  const r = rows[0];
  return r
    ? { timeS: r.time_s, distanceM: r.distance_m, moving: r.moving }
    : null;
}

function rateOf(
  kind: CorrectionActivityKind,
  km: number,
  s: number,
): number | null {
  return kind === 'run' ? avgPaceSPerKm(km, s) : avgSpeedKmh(km, s);
}

async function plan(
  kind: CorrectionActivityKind,
  a: ActivityRow,
  requests: CorrectionRequest[],
  db: Queryable,
): Promise<CorrectionPreview> {
  const p = planCorrection(
    {
      distanceKm: a.distanceKm,
      durationS: a.durationS,
      startedAt: a.startedAt,
    },
    await loadPrimaryStream(kind, a.id, db),
    requests,
  );
  return {
    kind,
    plan: p,
    rate: {
      before: rateOf(kind, p.before.distanceKm, p.before.durationS),
      after: rateOf(kind, p.after.distanceKm, p.after.durationS),
    },
  };
}

/** The before → after preview, nothing written. Throws CorrectionError on a bad request. */
export async function previewCorrection(
  kind: CorrectionActivityKind,
  id: string,
  requests: CorrectionRequest[],
): Promise<CorrectionPreview> {
  const db: Queryable = { query: query as Queryable['query'] };
  return plan(kind, await loadActivity(kind, id, db, false), requests, db);
}

export interface CorrectionResult extends CorrectionPreview {
  qualitativeLogId: string;
  derived: DerivedRecomputeResult;
}

export type { CorrectionPreview };

/** Athlete-local date (+ training block/week) of an instant. */
function localDateOf(startedAt: string): {
  date: string;
  block: number | null;
  week: number | null;
} {
  const date = athleteLocalParts(startedAt, getAthleteProfile().timeZone).date;
  return { date, ...computeBlockWeek(date) };
}

/** The stream columns a late-stop cut slices — exported so a test can hold it to the table's real array columns. */
export function streamCutColumns(
  kind: CorrectionActivityKind,
): readonly string[] {
  return KINDS[kind].arrays;
}

async function cutStreams(
  kind: CorrectionActivityKind,
  id: string,
  cutAtS: number,
  client: PoolClient,
): Promise<void> {
  const k = KINDS[kind];
  // Arrays are ordered by time_s; keep the leading samples with time_s ≤ cut.
  // Slicing a NULL array yields NULL, so absent sensors stay absent.
  const sets = k.arrays.map((c) => `${c} = s.${c}[1:n.keep]`).join(', ');
  await client.query(
    `UPDATE public.${k.streams} s
        SET ${sets}, sample_count = n.keep
       FROM (SELECT ${k.fk} AS fk, source,
                    (SELECT count(*)::int FROM unnest(time_s) t WHERE t <= $2) AS keep
               FROM public.${k.streams} WHERE ${k.fk} = $1) n
      WHERE s.${k.fk} = n.fk AND s.source = n.source`,
    [id, cutAtS],
  );
}

/**
 * Apply `requests` in order and record them. `transcript` is the athlete's
 * own words for the qualitative_logs row (null when the form had none).
 */
export async function applyCorrection(
  kind: CorrectionActivityKind,
  id: string,
  requests: CorrectionRequest[],
  transcript: string | null,
): Promise<CorrectionResult> {
  const k = KINDS[kind];
  const { preview, qualitativeLogId, oldDate, newDate, startMoved } =
    await withTransaction(async (client) => {
      const a = await loadActivity(kind, id, client, true);
      const preview = await plan(kind, a, requests, client);
      const { after } = preview.plan;

      const patch: Record<string, unknown> = {
        distance_km: after.distanceKm,
        duration_s: after.durationS,
        [kind === 'run' ? 'avg_pace_s_per_km' : 'avg_speed_kmh']:
          preview.rate.after,
      };
      const startMoved =
        after.startedAt !== a.startedAt && after.startedAt != null;
      let newDate = a.date;
      if (startMoved) {
        patch.started_at = after.startedAt;
        const local = localDateOf(after.startedAt!);
        if (local.date !== a.date) {
          newDate = local.date;
          Object.assign(patch, local);
        }
      }
      if (kind === 'run') await correctRun(id, patch, client);
      else await correctRide(id, patch, client);

      if (preview.plan.streamCutAtS != null) {
        await cutStreams(kind, id, preview.plan.streamCutAtS, client);
        // An open missed-stop suggestion (MZY-254) no longer lands on the cut
        // stream; applying one marks it 'applied' right after this.
        await client.query(
          `UPDATE public.missed_stop_suggestions
              SET status = 'stale', resolved_at = now()
            WHERE ${k.fk} = $1 AND status = 'open'`,
          [id],
        );
      }

      const notes = preview.plan.steps.map((s) => s.note).join('\n');
      await client.query(
        `UPDATE public.${k.table}
            SET general_notes = COALESCE(general_notes || E'\\n', '') || $2
          WHERE id = $1`,
        [id, notes],
      );

      const rateLabel =
        kind === 'run'
          ? `${fmtDurationS(preview.rate.after ?? 0)}/km`
          : `${(preview.rate.after ?? 0).toFixed(2)} km/h`;
      const summary =
        `${notes}\nCorrected totals: ${after.distanceKm.toFixed(3)} km in ` +
        `${fmtDurationS(after.durationS)} (${rateLabel}), from ` +
        `${preview.plan.before.distanceKm.toFixed(3)} km in ` +
        `${fmtDurationS(preview.plan.before.durationS)}.`;
      const qualitativeLogId = await insertQualitativeLog(
        {
          date: newDate,
          sessionType: kind,
          rawTranscript: transcript,
          parsedJson: {
            source: 'manual_correction',
            [k.idKey]: id,
            ...(a.stravaActivityId
              ? { stravaActivityId: a.stravaActivityId }
              : {}),
            general_notes: summary,
            corrections: preview.plan.steps.map((s) => s.entry),
            before: preview.plan.before,
            after,
          },
        },
        client,
      );
      return {
        preview,
        qualitativeLogId,
        oldDate: a.date,
        newDate,
        startMoved,
      };
    });

  const derived = await recomputeDerivedForActivity(kind, id, {
    startMoved,
    fromDate: oldDate < newDate ? oldDate : newDate,
  });
  return { ...preview, qualitativeLogId, derived };
}

export interface RevertResult {
  reverted: string[];
  derived: DerivedRecomputeResult | null;
}

/**
 * Hand a group of columns back to the source (services/activityCorrections.ts
 * revertCorrections). The start group is restored exactly from
 * source_started_at, with date/block/week re-derived from it; the totals group
 * takes the source's values at the next re-sync. A stream trim stays.
 */
export async function revertCorrectionGroup(
  kind: CorrectionActivityKind,
  id: string,
  group: RevertGroup,
): Promise<RevertResult> {
  const k = KINDS[kind];
  const { reverted, dates } = await withTransaction(async (client) => {
    const before = await loadActivity(kind, id, client, true);
    const reverted = await revertCorrections(
      k.table,
      id,
      revertGroupFields(kind, group),
      client,
    );
    let after = before.date;
    if (reverted.includes('started_at')) {
      const now = await loadActivity(kind, id, client, false);
      if (now.startedAt) {
        const local = localDateOf(now.startedAt);
        after = local.date;
        await client.query(
          `UPDATE public.${k.table} SET date = $2, block = $3, week = $4 WHERE id = $1`,
          [id, local.date, local.block, local.week],
        );
      }
    }
    return { reverted, dates: [before.date, after] };
  });
  if (!reverted.includes('started_at')) return { reverted, derived: null };
  const derived = await recomputeDerivedForActivity(kind, id, {
    startMoved: true,
    fromDate: dates[0]! < dates[1]! ? dates[0]! : dates[1]!,
  });
  return { reverted, derived };
}
