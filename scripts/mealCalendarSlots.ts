import { DEFAULT_TIME_ZONE } from '../services/googleCalendar';
import type { CalendarEventInput } from '../services/googleCalendar/types';

// Shared slot data + event-building for the "Agon Meals" calendar scripts
// (sync-meal-calendar.ts creates the 5 recurring events; retime-meal-calendar.ts
// adjusts their times without duplicating them). One definition, two callers.

export const BLOCK_START = '2026-09-07';
// Recurrence UNTIL in UTC, one day past Dec 19 local to safely include it
// regardless of the CET offset. Matches the end of the training block the
// meal plan was written for; adjust both constants for your own block.
export const RECURRENCE_UNTIL = '20261220T000000Z';

export interface MealSlot {
  key: string;
  emoji: string;
  title: string;
  hour: number;
  minute: number;
  durationMin: number;
  primary: string;
  secondary: string;
}

export const SLOTS: MealSlot[] = [
  {
    key: 'breakfast',
    emoji: '🍳',
    title: 'Breakfast',
    hour: 8,
    minute: 0,
    durationMin: 20,
    primary: 'Egg ×3, wholemeal bread ×2, coffee',
    secondary: 'Elinas Greek yoghurt ×1, koelln muesli ×3, grapes ×1, coffee',
  },
  {
    key: 'lunch',
    emoji: '🍽️',
    title: 'Lunch',
    hour: 12,
    minute: 30,
    durationMin: 30,
    primary: 'LikeMeat grilled chicken ×1, wholemeal pasta ×1, Campo Verde Erbsen ×1',
    secondary: 'Deutsche See Lachsfilet ×1, wholemeal pasta ×1, Campo Verde Erbsen ×1',
  },
  {
    key: 'snack',
    emoji: '🍎',
    title: 'Snack',
    hour: 16,
    minute: 30,
    durationMin: 15,
    primary: 'Apple ×1, koelln muesli ×2, Tafeltrauben blau ×1, maple syrup ×0.5',
    secondary: 'Apple ×1, rewe protein pudding ×1, maple syrup ×0.5',
  },
  {
    key: 'dinner',
    emoji: '🌙',
    title: 'Dinner',
    hour: 19,
    minute: 0,
    durationMin: 30,
    primary: 'Turkey breast ×2, wholemeal pasta ×1, Campo Verde Erbsen ×1',
    secondary: 'Turkey breast ×2, wholemeal bread ×2, King Cuisine hummus ×1',
  },
  {
    // Timed to the weekday 22:00 lift rather than the midday run — adjusted
    // 2026-09-07 per the athlete's direct instruction.
    key: 'post_workout',
    emoji: '🥤',
    title: 'Post-workout',
    hour: 22,
    minute: 15,
    durationMin: 15,
    primary: 'Whey protein ×1, Schwarzwaldmilch protein milk ×3',
    secondary: 'foodspring protein bar ×1, vly Erbsen-Drink ×3, Tafeltrauben hell ×2',
  },
];

export function addMinutes(hour: number, minute: number, add: number) {
  const total = hour * 60 + minute + add;
  return { hour: Math.floor(total / 60), minute: total % 60 };
}
export const pad = (n: number): string => String(n).padStart(2, '0');

export function buildMealEventInput(slot: MealSlot): CalendarEventInput {
  const end = addMinutes(slot.hour, slot.minute, slot.durationMin);
  const description = [
    `<b>Primary:</b> ${slot.primary}`,
    '',
    `<b>Secondary:</b> ${slot.secondary}`,
    '',
    'Planned by Agon',
  ].join('<br>');

  return {
    summary: `${slot.emoji} ${slot.title}`,
    description,
    start: {
      dateTime: `${BLOCK_START}T${pad(slot.hour)}:${pad(slot.minute)}:00`,
      timeZone: DEFAULT_TIME_ZONE,
    },
    end: {
      dateTime: `${BLOCK_START}T${pad(end.hour)}:${pad(end.minute)}:00`,
      timeZone: DEFAULT_TIME_ZONE,
    },
    recurrence: [`RRULE:FREQ=DAILY;UNTIL=${RECURRENCE_UNTIL}`],
  };
}
