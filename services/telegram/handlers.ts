import { query } from '../db';
import { logger } from '../logger';
import { enrichMissingWeather } from '../weather/enrich';
import {
  postSyncMissedStops,
  resolveSuggestion,
  SuggestionStateError,
  type ResolveResult,
} from '../missedStops';
import { fmtDurationS } from '../../lib/activityCorrection';
import { insertBodyMetric } from '../bodyMetrics';
import { recordSweatObservation } from '../sweat';
import { recordCaptureEvent, undoLastCaptureEvent } from '../captureEvents';
import { athleteLocalParts } from '../../lib/time';
import { getAthleteProfile } from '../../lib/athleteProfile';
import {
  computeBlockWeek,
  programWeekRange,
} from '../../lib/training/trainingBlocks';
import {
  syncNewGoogleHealthRuns,
  describeGoogleHealthSyncSummary,
  type GoogleHealthSyncSummary,
} from '../googleHealth/sync';
import {
  addAdHocRoute,
  type AddAdHocRouteInput,
  type AddAdHocRouteResult,
} from '../adHocRoute';
import { parseCommand, CommandError, type ParsedCommand } from './commands';
import {
  isCyclingProfile,
  type HillPreference,
  type RouteProfile,
} from '../routing/types';
import { gearMileage } from '../marts/gear';
import {
  findActiveBikeGear,
  findMaintenanceTask,
  loadMaintenanceTasks,
  recordMaintenanceLog,
} from '../gearMaintenance';
import { resolveBike } from '../../lib/gearMaintenance';

// Execute a parsed Telegram command against the DB and return the reply text.
// Thin: parsing/validation is in commands.ts, storage in the service modules;
// this only wires them and formats a human reply. The webhook (deployment layer)
// hands raw message text to handleCommandText and sends the returned string back.

export interface CommandContext {
  /** Athlete-local date the message arrived, YYYY-MM-DD. */
  today: string;
  /**
   * Trigger an incremental run pull for the `/sync` command. Injectable so the
   * unit lane can stub it — defaults to the real network-backed Google Health
   * sync (the forward run source after the Strava pivot). Source-neutral name so
   * repointing the provider is a one-line change here, not a handler rewrite.
   */
  syncRuns?: () => Promise<GoogleHealthSyncSummary>;
  /** Ad-hoc route generator for `/route`. Injectable so the unit lane can stub it. */
  addRoute?: (input: AddAdHocRouteInput) => Promise<AddAdHocRouteResult>;
  /** The chat the message came from, for `/whoami`. Absent outside Telegram. */
  chatId?: number;
}

function defaultContext(): CommandContext {
  return {
    today: athleteLocalParts(
      new Date().toISOString(),
      getAthleteProfile().timeZone,
    ).date,
  };
}

async function weekSummary(today: string): Promise<string> {
  const { block, week } = computeBlockWeek(today);
  const range = programWeekRange(today);
  if (block == null || week == null || range == null) {
    return `Program hasn't started yet — it begins ${getAthleteProfile().trainingStartDate}.`;
  }
  const { rows } = await query<{ runs: string; lifts: string }>(
    `SELECT
       (SELECT count(*) FROM public.runs
          WHERE date BETWEEN $1 AND $2) AS runs,
       (SELECT count(*) FROM public.lifting_sessions
          WHERE date BETWEEN $1 AND $2) AS lifts`,
    [range.start, range.end],
  );
  const runs = rows[0]?.runs ?? '0';
  const lifts = rows[0]?.lifts ?? '0';
  return [
    `📅 Block ${block} · Week ${week}`,
    `${range.start} → ${range.end}`,
    `Runs: ${runs} · Lifts: ${lifts}`,
  ].join('\n');
}

/** Resolve a /route day token ('today' | 'tomorrow' | ISO) to a YYYY-MM-DD date. */
function resolveDay(day: string, today: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  if (day === 'tomorrow') {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  return today; // 'today' or unrecognised
}

const SURFACE_LABEL: Record<RouteProfile, string | null> = {
  'foot-walking': null,
  'cycling-regular': null,
  'cycling-road': 'road',
  'cycling-mountain': 'gravel',
};

/** Format the ad-hoc route result as a Telegram reply (URLs auto-link). */
function formatRouteReply(
  dateISO: string,
  result: AddAdHocRouteResult,
  profile: RouteProfile,
  hills: HillPreference | undefined,
): string {
  const lines: string[] = [];
  const constraint = [
    result.throughLabels.length
      ? `through ${result.throughLabels.join(', ')}`
      : '',
    result.finishLabel ? `finishing near ${result.finishLabel}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const icon = isCyclingProfile(profile) ? '🚴' : '🧭';
  // Echo the cycling preferences back, so a misparsed keyword is visible.
  const prefs = [SURFACE_LABEL[profile], hills].filter(Boolean).join(', ');
  lines.push(
    `${icon} Ad hoc route${prefs ? ` (${prefs})` : ''}${constraint ? ` — ${constraint}` : ''} (${dateISO}):`,
  );
  for (const w of result.geocodeWarnings) lines.push(`⚠️ ${w}`);
  if (result.spineOnly) {
    lines.push(
      '⚠️ The through/finish route already meets your distance — no padding loop added.',
    );
  }
  for (const r of result.routes) {
    lines.push(`• ${r.label ?? `${r.distanceKm.toFixed(1)} km`}\n${r.mapsUrl}`);
  }
  if (result.sessionCreated) {
    lines.push('📅 Added a new run to your calendar for that day.');
  } else if (result.calendarUpdated) {
    lines.push("📅 Added to that day's run event.");
  }
  if (!result.calendarUpdated) {
    lines.push('(Saved — will appear on your calendar at the next sync.)');
  }
  return lines.join('\n');
}

/** A context for a message from `chatId`; `today` overrides the athlete-local date (tests). */
export function contextFor(chatId: number, today?: string): CommandContext {
  return { ...defaultContext(), ...(today ? { today } : {}), chatId };
}

export async function executeCommand(
  cmd: ParsedCommand,
  ctx: CommandContext = defaultContext(),
): Promise<string> {
  switch (cmd.kind) {
    case 'weight': {
      const id = await insertBodyMetric({
        date: ctx.today,
        weightKg: cmd.weightKg,
        bodyFatPct: null,
        notes: null,
      });
      await recordCaptureEvent({
        kind: 'weight',
        summary: `weight ${cmd.weightKg} kg`,
        targets: [{ table: 'body_metrics', id }],
      });
      return `✅ Logged weight ${cmd.weightKg} kg (${ctx.today}).`;
    }
    case 'bf': {
      const id = await insertBodyMetric({
        date: ctx.today,
        weightKg: null,
        bodyFatPct: cmd.bodyFatPct,
        notes: null,
      });
      await recordCaptureEvent({
        kind: 'bf',
        summary: `body fat ${cmd.bodyFatPct}%`,
        targets: [{ table: 'body_metrics', id }],
      });
      return `✅ Logged body fat ${cmd.bodyFatPct}% (${ctx.today}).`;
    }
    case 'sweat': {
      const r = await recordSweatObservation({
        date: ctx.today,
        preKg: cmd.preKg,
        postKg: cmd.postKg,
        fluidL: cmd.fluidL,
      });
      await recordCaptureEvent({
        kind: 'sweat',
        summary: `sweat weigh-in (pre ${cmd.preKg} / post ${cmd.postKg} kg)`,
        targets: [{ table: 'sweat_observations', id: r.id }],
      });
      if (r.sweatRateLPerH == null) {
        return (
          `✅ Logged weigh-in (pre ${cmd.preKg} / post ${cmd.postKg} kg, ` +
          `fluid ${cmd.fluidL} L). No run found on ${ctx.today} to derive a rate — ` +
          `stored for later.`
        );
      }
      return (
        `✅ New sweat rate: ${r.sweatRateLPerH} L/h ` +
        `(pre ${cmd.preKg} / post ${cmd.postKg} kg, fluid ${cmd.fluidL} L). ` +
        `Baseline updated.`
      );
    }
    case 'week':
      return weekSummary(ctx.today);
    case 'whoami':
      // Lets the owner read their chat id from the running bot: a manual
      // getUpdates call would fight the long-poll listener for the same updates
      // (install audit F-19). The id is the caller's own, so replying is safe.
      return ctx.chatId === undefined
        ? '⚠️ No chat id on this message.'
        : `🆔 This chat's id is ${ctx.chatId}.\nTo get Agon's reminders and alerts here, set TELEGRAM_OWNER_CHAT_ID=${ctx.chatId} in .env.local and restart the bot.`;
    case 'sync': {
      // Transport-thin: parse/validation is done; this just runs the incremental
      // Google Health pull and formats the result. A missing token / network
      // hiccup becomes a friendly reply rather than a thrown 500 — the user retries.
      const runSync =
        ctx.syncRuns ??
        (async () => {
          const summary = await syncNewGoogleHealthRuns();
          await enrichMissingWeather(); // MZY-226 — best-effort
          await postSyncMissedStops(); // MZY-254 — best-effort
          return summary;
        });
      try {
        const summary = await runSync();
        return `🔄 ${describeGoogleHealthSyncSummary(summary)}`;
      } catch (err) {
        logger.error('telegram /sync failed', { job: 'telegram-command' }, err);
        return '⚠️ Run sync failed — check the tokens (pnpm gh:auth) and try again.';
      }
    }
    case 'undo': {
      const undone = await undoLastCaptureEvent();
      if (!undone) return '↩️ Nothing to undo — no recent entries.';
      return `↩️ Undone: ${undone.summary}.`;
    }
    case 'route': {
      const dateISO = resolveDay(cmd.day, ctx.today);
      const run = ctx.addRoute ?? ((input) => addAdHocRoute(input));
      try {
        const result = await run({
          dateISO,
          targetKm: cmd.targetKm,
          through: cmd.through.length ? cmd.through : undefined,
          finishNear: cmd.finishNear ?? undefined,
          profile: cmd.profile,
          hills: cmd.hills,
        });
        if (result.routes.length === 0) {
          return '⚠️ Couldn’t build a route for that request — try a different distance or place.';
        }
        return formatRouteReply(dateISO, result, cmd.profile, cmd.hills);
      } catch (err) {
        logger.error(
          'telegram /route failed',
          { job: 'telegram-command' },
          err,
        );
        return '⚠️ Route generation failed — check the place names and try again.';
      }
    }
    case 'stop': {
      let r: ResolveResult;
      try {
        r = await resolveSuggestion({ shortId: cmd.shortId }, cmd.action);
      } catch (err) {
        if (err instanceof SuggestionStateError) {
          return `⚠️ Missed-stop #${cmd.shortId}: ${err.message}.`;
        }
        throw err;
      }
      const what = `${r.suggestion.kind} on ${r.suggestion.date}`;
      if (r.status === 'dismissed') {
        return `👍 Kept the ${what} as recorded — won't ask again.`;
      }
      if (r.status === 'stale') {
        return `⚠️ The ${what} changed since this was flagged — nothing trimmed. Check it on the activity page.`;
      }
      const after = r.correction.plan.after;
      return (
        `✂️ Trimmed the last ${fmtDurationS(r.suggestion.trimS)} off the ${what}. ` +
        `Now ${after.distanceKm.toFixed(2)} km in ${fmtDurationS(after.durationS)}.`
      );
    }
    case 'maintained': {
      const resolved = resolveBike(await findActiveBikeGear(), cmd.bikeName);
      if (!resolved.ok) {
        const names = resolved.candidates.map((b) => b.name).join(', ');
        switch (resolved.reason) {
          case 'none':
            return '⚠️ No active bike found in your gear — add one first.';
          case 'ambiguous':
            return (
              `⚠️ Which bike? ${names} — e.g. ` +
              `/maintained ${cmd.taskKey} on ${resolved.candidates[0]!.name}`
            );
          case 'no-match':
            return `⚠️ No active bike matches "${cmd.bikeName}". Active bikes: ${names}`;
        }
      }
      const bike = resolved.bike;

      const task = await findMaintenanceTask(cmd.taskKey);
      if (!task) {
        const known = (await loadMaintenanceTasks())
          .map((t) => t.taskKey)
          .join(', ');
        return `⚠️ Unknown task "${cmd.taskKey}". Known tasks: ${known}`;
      }

      const gear = await gearMileage();
      const totalKm = gear.find((g) => g.gearId === bike.gearId)?.totalKm ?? 0;

      const id = await recordMaintenanceLog({
        gearId: bike.gearId,
        taskKey: task.taskKey,
        performedAt: ctx.today,
        kmAtService: totalKm,
      });
      await recordCaptureEvent({
        kind: 'maintained',
        summary: `${task.name} on ${bike.name} at ${totalKm.toFixed(0)} km`,
        targets: [{ table: 'gear_maintenance_log', id }],
      });
      return `✅ Logged ${task.name} for ${bike.name} at ${totalKm.toFixed(0)} km.`;
    }
  }
}

/**
 * Full path from raw message text to reply. A CommandError (bad input) becomes a
 * friendly reply, not a thrown 500 — the user just retries. Unexpected errors
 * still throw so the webhook logs + 500s them.
 */
export async function handleCommandText(
  text: string,
  ctx: CommandContext = defaultContext(),
): Promise<string> {
  let cmd: ParsedCommand;
  try {
    cmd = parseCommand(text);
  } catch (err) {
    if (err instanceof CommandError) return `⚠️ ${err.message}`;
    throw err;
  }
  const reply = await executeCommand(cmd, ctx);
  logger.info('telegram command handled', {
    job: 'telegram-command',
    kind: cmd.kind,
  });
  return reply;
}
