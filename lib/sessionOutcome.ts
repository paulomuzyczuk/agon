// What the recorded data says about a planned session (MZY-417). Pure: shared by
// the weekly reconciliation that writes it and the calendar mapper that renders
// it, so the wording lives in one place.

export interface SessionOutcome {
  status: 'done' | 'not_done';
  /** Distance the plan asked for before the realized overlay, km (null: none). */
  plannedKm: number | null;
  /** Realized distance, km — only when done. */
  actualKm?: number;
  /** Realized local start, "HH:MM" — only when done and known. */
  actualStart?: string;
  /** Realized duration, minutes — only when done and known. */
  actualDurationMin?: number;
  /** Where the activity came from (strava, live_recording, ...). */
  source?: string;
}

/** Status marker placed in front of the event title's kind emoji. */
export function outcomeTitlePrefix(
  o: SessionOutcome | null | undefined,
): string {
  if (!o) return '';
  return o.status === 'done' ? '✅ ' : '❌ ';
}

/** One description line explaining the outcome, or null when there is none. */
export function outcomeNote(
  o: SessionOutcome | null | undefined,
): string | null {
  if (!o) return null;
  if (o.status === 'not_done') {
    const planned = o.plannedKm !== null ? ` (planned ${o.plannedKm} km)` : '';
    return `❌ Not done — nothing recorded that day${planned}`;
  }
  const actual = o.actualKm !== undefined ? ` ${o.actualKm} km` : '';
  const planned =
    o.plannedKm !== null && o.plannedKm !== o.actualKm
      ? ` (planned ${o.plannedKm} km)`
      : '';
  const from = o.source ? ` · ${o.source}` : '';
  return `✅ Done —${actual}${planned}${from}`.replace('— ·', '—');
}

/** True when two outcomes say the same thing (the weekly job is idempotent). */
export function sameOutcome(
  a: SessionOutcome | null | undefined,
  b: SessionOutcome | null | undefined,
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
