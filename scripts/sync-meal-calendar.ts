import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { getValidAccessToken, ensureCalendar, insertEvent } from '../services/googleCalendar';
import { SLOTS, buildMealEventInput, BLOCK_START } from './mealCalendarSlots';
import { logger } from '../services/logger';

// Populate the (previously dormant) "Agon Meals" calendar with 5 standing daily
// recurring events — one per meal slot — each showing the Primary (Option A)
// and Secondary (Option B) choice from lib/mealTemplates.ts's cut-day templates.
// Bounded to one training block (BLOCK_START → RECURRENCE_UNTIL in
// scripts/mealCalendarSlots.ts), matching the training-calendar sync's scope. Slot times/content
// live in scripts/mealCalendarSlots.ts (shared with retime-meal-calendar.ts).
//
//   pnpm sync:meal-calendar
//
// NOT idempotent — there's no DB tracking of these event IDs the way
// planned_sessions.gcal_event_id tracks training events, so re-running this
// script creates duplicate recurring series. Run once to create; use
// `pnpm retime:meal-calendar` (with the event IDs it printed) to adjust times
// afterward instead of re-running this.

async function main(): Promise<void> {
  loadEnv();
  const token = await getValidAccessToken();
  const calendarId = await ensureCalendar(token, 'meals');

  for (const slot of SLOTS) {
    const created = await insertEvent(token, calendarId, buildMealEventInput(slot));
    logger.info('meal calendar event created', {
      job: 'sync-meal-calendar',
      slot: slot.key,
      eventId: created.id,
    });
    // eslint-disable-next-line no-console
    console.log(`Created recurring event: ${slot.emoji} ${slot.title} @ ${slot.hour}:${String(slot.minute).padStart(2, '0')} (id: ${created.id})`);
  }

  // eslint-disable-next-line no-console
  console.log(`\nDone — 5 recurring meal events on the Agon Meals calendar, ${BLOCK_START} through 2026-12-19.\n`);
}

main()
  .catch((err) => {
    logger.error('sync-meal-calendar failed', { job: 'sync-meal-calendar' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
