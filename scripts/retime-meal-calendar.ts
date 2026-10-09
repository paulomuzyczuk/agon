import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { getValidAccessToken, ensureCalendar, patchEvent } from '../services/googleCalendar';
import { SLOTS, buildMealEventInput } from './mealCalendarSlots';
import { logger } from '../services/logger';

// Re-time the 5 standing "Agon Meals" recurring events to match the current
// times in scripts/mealCalendarSlots.ts, without deleting/recreating them
// (patchEvent on a recurring master moves the whole series' time-of-day, not
// just one instance). Event IDs below are from the original `sync:meal-calendar`
// creation run (2026-09-07) — update this map if the events are ever recreated.
//
//   pnpm retime:meal-calendar

const EVENT_IDS: Record<string, string> = {
  breakfast: 'uj8le6km6d5lb2ivkksilon0gc',
  post_workout: '7hr7b7u1mhm52gjp2artape6rg',
  lunch: 'cq51n6qt74ds7l7gbs869eu4nk',
  snack: 'oum18o9qaadd0nrgccd1sji8lo',
  dinner: '0forslc8pnra9vfku00881l0cg',
};

async function main(): Promise<void> {
  loadEnv();
  const token = await getValidAccessToken();
  const calendarId = await ensureCalendar(token, 'meals');

  for (const slot of SLOTS) {
    const eventId = EVENT_IDS[slot.key];
    if (!eventId) {
      logger.warn('no known event id for slot — skipped', { job: 'retime-meal-calendar', slot: slot.key });
      continue;
    }
    await patchEvent(token, calendarId, eventId, buildMealEventInput(slot));
    // eslint-disable-next-line no-console
    console.log(`Re-timed: ${slot.emoji} ${slot.title} -> ${slot.hour}:${String(slot.minute).padStart(2, '0')}`);
  }

  // eslint-disable-next-line no-console
  console.log('\nDone — all 5 recurring series updated in place.\n');
}

main()
  .catch((err) => {
    logger.error('retime-meal-calendar failed', { job: 'retime-meal-calendar' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
