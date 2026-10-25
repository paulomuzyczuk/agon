import { query } from './db';
import { logger } from './logger';
import { homeLocationOrNull } from './routing/config';
import { sendMessage as telegramSend } from './telegram/api';
import {
  applyCorrection,
  previewCorrection,
  type CorrectionResult,
} from './activityCorrectionFlow';
import {
  DETECTION_PARAMS_BY_KIND,
  detectMissedStop,
  type MissedStopSuggestion,
} from '../lib/missedStopDetection';
import { fmtDurationS } from '../lib/activityCorrection';

// Missed-stop suggestions (MZY-254): after every sync, look for runs/rides
// that ended in a slow tail (lib/missedStopDetection.ts) and store a
// suggested late-stop trim in public.missed_stop_suggestions. Suggest-only —
// hand edits win. Applying one runs the MZY-253 late-stop correction;
// dismissing it is remembered (one row per activity, never re-flagged).
// Activities the athlete already trimmed by hand are skipped.
//
// postSyncMissedStops() is the best-effort hook every sync entry point calls
// (same contract as the MZY-226 weather pass): it never throws.

export type StopKind = 'run' | 'ride';

/** Only recent activities are scanned each sync — history was backtested once. */
export const MISSED_STOP_LOOKBACK_DAYS = 30;

const T = {
  run: { table: 'runs', streams: 'run_streams', fk: 'run_id', idKey: 'runId' },
  ride: {
    table: 'rides',
    streams: 'ride_streams',
    fk: 'ride_id',
    idKey: 'rideId',
  },
} as const;

export interface StoredSuggestion extends MissedStopSuggestion {
  id: string;
  shortId: number;
  kind: StopKind;
  activityId: string;
  date: string;
  status: 'open' | 'applied' | 'dismissed' | 'stale';
}

interface SuggestionRow {
  id: string;
  short_id: number;
  run_id: string | null;
  ride_id: string | null;
  date: string;
  confidence: 'home' | 'away';
  cut_at_s: number;
  trim_s: number;
  distance_km: number;
  moving_s: number;
  status: StoredSuggestion['status'];
}

const SELECT_SUGGESTION = `
  SELECT m.id, m.short_id, m.run_id, m.ride_id, m.confidence, m.cut_at_s,
         m.trim_s, m.distance_km::float8 AS distance_km, m.moving_s, m.status,
         COALESCE(r.date, d.date)::text AS date
    FROM public.missed_stop_suggestions m
    LEFT JOIN public.runs r ON r.id = m.run_id
    LEFT JOIN public.rides d ON d.id = m.ride_id`;

function toStored(r: SuggestionRow): StoredSuggestion {
  return {
    id: r.id,
    shortId: r.short_id,
    kind: r.run_id ? 'run' : 'ride',
    activityId: (r.run_id ?? r.ride_id)!,
    date: r.date,
    confidence: r.confidence,
    cutAtS: r.cut_at_s,
    trimS: r.trim_s,
    distanceKm: r.distance_km,
    movingS: r.moving_s,
    status: r.status,
  };
}

/**
 * Scan recent activities with a GPS stream that have no suggestion yet (open,
 * applied or dismissed) and no hand-made late-stop trim, and store any new
 * suggestion. Returns the new ones.
 */
export async function detectNewMissedStops(
  lookbackDays: number = MISSED_STOP_LOOKBACK_DAYS,
): Promise<StoredSuggestion[]> {
  const home = homeLocationOrNull();
  const created: StoredSuggestion[] = [];
  for (const kind of ['run', 'ride'] as const) {
    const t = T[kind];
    // One GPS stream per activity, ordered like the correction flow's primary
    // stream (services/activityCorrectionFlow.ts) so the cut lands on it.
    const { rows } = await query<{
      id: string;
      time_s: number[];
      lat: Array<number | null>;
      lng: Array<number | null>;
      distance_m: Array<number | null> | null;
      moving: Array<boolean | null> | null;
    }>(
      `SELECT DISTINCT ON (a.id) a.id, s.time_s,
              s.lat::float8[] AS lat, s.lng::float8[] AS lng,
              s.distance_m::float8[] AS distance_m, s.moving
         FROM public.${t.table} a
         JOIN public.${t.streams} s ON s.${t.fk} = a.id
        WHERE s.lat IS NOT NULL
          AND a.started_at >= now() - make_interval(days => $1)
          AND NOT EXISTS (SELECT 1 FROM public.missed_stop_suggestions m
                           WHERE m.${t.fk} = a.id)
          AND NOT EXISTS (
            SELECT 1 FROM public.qualitative_logs q
             WHERE q.parsed_json->>'source' = 'manual_correction'
               AND q.parsed_json->>'${t.idKey}' = a.id::text
               AND q.parsed_json->'corrections' @> '[{"kind":"late_stop_trim"}]')
        ORDER BY a.id, (s.distance_m IS NOT NULL AND s.moving IS NOT NULL) DESC,
                 (s.distance_m IS NOT NULL) DESC, s.sample_count DESC, s.source`,
      [lookbackDays],
    );
    for (const r of rows) {
      const hit = detectMissedStop(
        {
          timeS: r.time_s,
          lat: r.lat,
          lng: r.lng,
          distanceM: r.distance_m,
          moving: r.moving,
        },
        home,
        DETECTION_PARAMS_BY_KIND[kind],
      );
      if (!hit) continue;
      const { rows: ins } = await query<{ id: string }>(
        `INSERT INTO public.missed_stop_suggestions
           (${t.fk}, confidence, cut_at_s, trim_s, distance_km, moving_s)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          r.id,
          hit.confidence,
          hit.cutAtS,
          hit.trimS,
          hit.distanceKm,
          hit.movingS,
        ],
      );
      if (ins[0]) {
        const s = await getSuggestion({ id: ins[0].id });
        if (s) created.push(s);
      }
    }
  }
  return created;
}

export async function getSuggestion(
  ref: { id: string } | { shortId: number },
): Promise<StoredSuggestion | null> {
  const { rows } = await query<SuggestionRow>(
    'id' in ref
      ? `${SELECT_SUGGESTION} WHERE m.id = $1`
      : `${SELECT_SUGGESTION} WHERE m.short_id = $1`,
    ['id' in ref ? ref.id : ref.shortId],
  );
  return rows[0] ? toStored(rows[0]) : null;
}

/** The open suggestion for one activity, for its detail page. */
export async function getOpenSuggestionFor(
  kind: StopKind,
  activityId: string,
): Promise<StoredSuggestion | null> {
  const { rows } = await query<SuggestionRow>(
    `${SELECT_SUGGESTION} WHERE m.${T[kind].fk} = $1 AND m.status = 'open'`,
    [activityId],
  );
  return rows[0] ? toStored(rows[0]) : null;
}

/** Every open suggestion, oldest first — the dashboard's "needs a look" list. */
export async function listOpenSuggestions(): Promise<StoredSuggestion[]> {
  const { rows } = await query<SuggestionRow>(
    `${SELECT_SUGGESTION} WHERE m.status = 'open' ORDER BY m.created_at, m.short_id`,
  );
  return rows.map(toStored);
}

/** "29 Sep" from YYYY-MM-DD. */
function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** The Telegram nudge text, with tap-to-send commands. */
export function nudgeText(s: StoredSuggestion): string {
  const what = `${s.kind} on ${shortDate(s.date)}`;
  const tail =
    `last ${fmtDurationS(s.trimS)} (${Math.round(s.distanceKm * 1000)} m, ` +
    `${s.movingS} s moving)`;
  const head =
    s.confidence === 'home'
      ? `🏠 Looks like the recording kept running after you got home — ${what}: ${tail}.`
      : `📍 Your ${what} ends in a slow tail away from home — ${tail}. Stopped somewhere and forgot to end it?`;
  return `${head}\nTap /trim_${s.shortId} to cut it, or /keep_${s.shortId} to leave it as is.`;
}

export type SendFn = (chatId: number, text: string) => Promise<void>;

/**
 * Send the Telegram nudge for every open suggestion not yet notified. Skipped
 * (and retried next sync) when the bot token or owner chat isn't configured —
 * with a warning, so a missing TELEGRAM_OWNER_CHAT_ID can't silently swallow
 * the nudges (2026-10-18: a suggestion sat un-notified with no trace).
 */
export async function notifyOpenSuggestions(
  send: SendFn = (chatId, text) => telegramSend(chatId, text),
): Promise<number> {
  const { rows } = await query<SuggestionRow>(
    `${SELECT_SUGGESTION} WHERE m.status = 'open' AND m.notified_at IS NULL
      ORDER BY m.short_id`,
  );
  if (rows.length === 0) return 0;
  const chatId = Number(process.env.TELEGRAM_OWNER_CHAT_ID);
  if (
    !Number.isFinite(chatId) ||
    chatId === 0 ||
    !process.env.TELEGRAM_BOT_TOKEN
  ) {
    logger.warn(
      'missed-stop nudge skipped — set TELEGRAM_OWNER_CHAT_ID and TELEGRAM_BOT_TOKEN in .env.local',
      {
        job: 'missed-stops',
        pending: rows.length,
        hasToken: Boolean(process.env.TELEGRAM_BOT_TOKEN),
        hasChatId: Number.isFinite(chatId) && chatId !== 0,
      },
    );
    return 0;
  }
  let sent = 0;
  for (const r of rows) {
    await send(chatId, nudgeText(toStored(r)));
    await query(
      'UPDATE public.missed_stop_suggestions SET notified_at = now() WHERE id = $1',
      [r.id],
    );
    sent++;
  }
  return sent;
}

/**
 * The post-sync hook: detect, then nudge. Best-effort — logged, never thrown,
 * so it can't fail the sync that called it.
 */
export async function postSyncMissedStops(send?: SendFn): Promise<void> {
  try {
    const created = await detectNewMissedStops();
    const notified = await notifyOpenSuggestions(send);
    if (created.length > 0 || notified > 0) {
      logger.info('missed-stop pass', {
        job: 'missed-stops',
        created: created.length,
        notified,
      });
    }
  } catch (err) {
    logger.warn('post-sync missed-stop pass failed — will retry next sync', {
      job: 'missed-stops',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export class SuggestionStateError extends Error {}

async function setStatus(
  id: string,
  status: StoredSuggestion['status'],
): Promise<void> {
  await query(
    `UPDATE public.missed_stop_suggestions
        SET status = $2, resolved_at = CASE WHEN $2 = 'open' THEN NULL ELSE now() END
      WHERE id = $1`,
    [id, status],
  );
}

export type ResolveResult =
  | {
      status: 'applied';
      suggestion: StoredSuggestion;
      correction: CorrectionResult;
    }
  | { status: 'dismissed'; suggestion: StoredSuggestion }
  | { status: 'stale'; suggestion: StoredSuggestion };

/**
 * Apply (the MZY-253 late-stop trim) or dismiss an open suggestion. A
 * suggestion whose cut no longer matches the stored stream (it was trimmed or
 * changed since detection) is marked stale instead of applied.
 */
export async function resolveSuggestion(
  ref: { id: string } | { shortId: number },
  action: 'apply' | 'dismiss',
): Promise<ResolveResult> {
  const s = await getSuggestion(ref);
  if (!s) throw new SuggestionStateError('no such suggestion');
  if (s.status !== 'open') {
    throw new SuggestionStateError(`suggestion already ${s.status}`);
  }
  if (action === 'dismiss') {
    await setStatus(s.id, 'dismissed');
    return { status: 'dismissed', suggestion: { ...s, status: 'dismissed' } };
  }
  const request = [{ kind: 'late_stop' as const, trimMin: s.trimS / 60 }];
  const preview = await previewCorrection(s.kind, s.activityId, request);
  if (preview.plan.streamCutAtS !== s.cutAtS) {
    await setStatus(s.id, 'stale');
    return { status: 'stale', suggestion: { ...s, status: 'stale' } };
  }
  const correction = await applyCorrection(
    s.kind,
    s.activityId,
    request,
    `Auto-detected missed stop (suggestion #${s.shortId}, ${s.confidence}) — trim applied.`,
  );
  await setStatus(s.id, 'applied');
  return {
    status: 'applied',
    suggestion: { ...s, status: 'applied' },
    correction,
  };
}
