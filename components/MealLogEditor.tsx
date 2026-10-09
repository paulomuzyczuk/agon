'use client';

import { useState } from 'react';
import type { MealLogSummary } from '@/lib/marts';
import { submitRows } from '@/lib/sync/client';
import type { SyncRow } from '@/lib/outboxQueue';

// Edit a logged meal in place (MZY-206): slot, notes, item quantities. Only
// the fields actually changed are written, each as a field-level outbox
// mutation — so the same meal edited on two devices keeps both changes when
// they touch different fields, and the later edit when they touch the same
// one (mergeField, server-side). Works offline like every other write.

const MEAL_SLOTS = [
  'breakfast',
  'lunch',
  'dinner',
  'snack',
  'post_workout',
  'other',
] as const;

export function MealLogEditor({
  log,
  onDone,
}: {
  log: MealLogSummary;
  onDone: (saved: boolean) => void;
}) {
  const [slot, setSlot] = useState(log.mealSlot);
  const [notes, setNotes] = useState(log.notes ?? '');
  const [qty, setQty] = useState(() =>
    log.items.map((i) => String(i.quantity)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const quantities = qty.map(Number);
    if (quantities.some((q) => !(q > 0)))
      return setError('Quantities must be greater than 0.');

    const meal: Record<string, unknown> = {};
    if (slot !== log.mealSlot) meal.meal_slot = slot;
    if ((notes.trim() || null) !== log.notes) meal.notes = notes.trim() || null;
    const rows: SyncRow[] = [];
    if (Object.keys(meal).length)
      rows.push({ table: 'meal_logs', id: log.id, values: meal });
    log.items.forEach((item, i) => {
      if (quantities[i] !== item.quantity) {
        rows.push({
          table: 'meal_log_items',
          id: item.id,
          values: { quantity: quantities[i] },
        });
      }
    });
    if (rows.length === 0) return onDone(false);

    setBusy(true);
    setError(null);
    try {
      const result = await submitRows({
        label: `Edit meal: ${slot.replace('_', ' ')}`,
        rows,
      });
      if (result.state === 'rejected') throw new Error(result.error);
      onDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="nt-log-edit">
      <div className="nt-field-row">
        <select
          className="nt-select"
          aria-label="Meal slot"
          value={slot}
          onChange={(e) => setSlot(e.target.value)}
        >
          {MEAL_SLOTS.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
      </div>
      {log.items.map((item, i) => (
        <div className="nt-item-row" key={item.id}>
          <span className="nt-log-items" style={{ flex: 1 }}>
            {item.foodName}
          </span>
          <input
            className="nt-input"
            type="number"
            min="0"
            step="0.1"
            aria-label={`${item.foodName} quantity`}
            value={qty[i]}
            onChange={(e) =>
              setQty(qty.map((q, j) => (j === i ? e.target.value : q)))
            }
          />
        </div>
      ))}
      <div className="nt-field-row">
        <input
          className="nt-input"
          style={{ flex: 1 }}
          placeholder="Notes"
          aria-label="Meal notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      <div className="nt-field-row">
        <button className="nt-btn" disabled={busy} onClick={save}>
          Save
        </button>
        <button
          className="nt-btn-ghost"
          disabled={busy}
          onClick={() => onDone(false)}
        >
          Cancel
        </button>
      </div>
      {error && <p className="nt-error">{error}</p>}
    </div>
  );
}
