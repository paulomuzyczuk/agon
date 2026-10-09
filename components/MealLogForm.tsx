'use client';

import { useEffect, useState } from 'react';
import type { FoodOption, MealTemplateSummary } from '@/lib/marts';
import { onOutboxDelivered, type SubmitResult } from '@/lib/outbox';
import { submitRows } from '@/lib/sync/client';
import type { SyncRow } from '@/lib/outboxQueue';
import { adHocMealRows, wholeTemplateRows } from '@/lib/sync/entryRows';

// The nutrition PWA's logging write path (interim, ahead of the Cronometer CSV
// import — CLAUDE.md "Nutrition" decision 2026-08-24). Two ways to log: one
// click to log a whole usual-meal template for the day, or an ad-hoc pick from
// the foods catalog (the only two sources of macro data available right now —
// no free-text entry, since that can't be priced).

const MEAL_SLOTS = [
  'breakfast',
  'lunch',
  'dinner',
  'snack',
  'post_workout',
  'other',
] as const;

interface AdHocRow {
  food: string;
  quantity: string;
}

export function MealLogForm({
  date,
  templates,
  onLogged,
}: {
  date: string;
  templates: MealTemplateSummary[];
  onLogged: () => void;
}) {
  const [foods, setFoods] = useState<FoodOption[] | null>(null);
  const [mealSlot, setMealSlot] =
    useState<(typeof MEAL_SLOTS)[number]>('breakfast');
  const [rows, setRows] = useState<AdHocRow[]>([{ food: '', quantity: '1' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Once the queued write has synced, the "saved on this device" note is stale.
  useEffect(() => onOutboxDelivered(() => setNotice(null)), []);

  useEffect(() => {
    let live = true;
    fetch('/api/nutrition/foods')
      .then((r) => r.json())
      .then((data: { foods: FoodOption[] }) => live && setFoods(data.foods))
      .catch(() => live && setFoods([]));
    return () => {
      live = false;
    };
  }, []);

  // Writes go through the device outbox (MZY-205): saved locally first, then
  // synced — so a meal logged offline is kept, not lost. Only a server
  // rejection throws; a queued write counts as logged. Since MZY-206 the
  // meal is built into field-level rows here (lib/sync/entryRows.ts).
  const newId = () => crypto.randomUUID();
  async function log(rows: SyncRow[], label: string): Promise<void> {
    const result: SubmitResult = await submitRows({ label, rows });
    if (result.state === 'rejected') throw new Error(result.error);
    setNotice(
      result.state === 'queued'
        ? result.reason === 'auth'
          ? 'Saved on this device — sign in again to sync it.'
          : 'Saved on this device — it will sync when you’re back online.'
        : null,
    );
  }

  async function logWholeTemplate(template: MealTemplateSummary) {
    setBusy(true);
    setError(null);
    try {
      await log(
        wholeTemplateRows(
          { date, templateId: template.id, items: template.items },
          newId,
        ),
        `Meal plan: ${template.name}`,
      );
      onLogged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'log failed');
    } finally {
      setBusy(false);
    }
  }

  async function submitAdHoc() {
    const items = rows
      .filter((r) => r.food.trim() !== '')
      .map((r) => ({
        food: r.food,
        foodId: foods?.find((f) => f.name === r.food)?.id,
        quantity: Number(r.quantity),
      }));
    if (items.length === 0) {
      setError('Pick at least one food.');
      return;
    }
    if (items.some((i) => !(i.quantity > 0))) {
      setError('Quantities must be greater than 0.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const unknown = items.find((i) => !i.foodId);
      if (unknown) throw new Error(`Unmatched food "${unknown.food}".`);
      await log(
        adHocMealRows(
          {
            date,
            mealSlot,
            items: items.map((i) => ({
              foodId: i.foodId!,
              quantity: i.quantity,
            })),
          },
          newId,
        ),
        `Meal: ${mealSlot.replace('_', ' ')} (${items.map((i) => i.food).join(', ')})`,
      );
      setRows([{ food: '', quantity: '1' }]);
      onLogged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'log failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ marginTop: '1rem' }}>
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>Log a meal</h2>

      {templates.length > 0 && (
        <>
          <p className="muted small" style={{ margin: '0 0 0.4rem' }}>
            One-click: log a whole usual meal for {date}.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {templates.map((t) => (
              <button
                key={t.id}
                className="nt-btn-ghost"
                disabled={busy}
                onClick={() => logWholeTemplate(t)}
              >
                {t.name}
              </button>
            ))}
          </div>
        </>
      )}

      <p className="muted small" style={{ margin: '0.75rem 0 0' }}>
        Or log foods ad hoc from the catalog:
      </p>
      <div className="nt-field-row">
        <select
          className="nt-select"
          value={mealSlot}
          onChange={(e) => setMealSlot(e.target.value as typeof mealSlot)}
        >
          {MEAL_SLOTS.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
      </div>

      {rows.map((row, i) => (
        <div className="nt-item-row" key={i}>
          <select
            className="nt-select"
            value={row.food}
            disabled={foods === null}
            onChange={(e) => {
              const next = [...rows];
              next[i] = { ...next[i]!, food: e.target.value };
              setRows(next);
            }}
          >
            <option value="">
              {foods === null ? 'Loading foods…' : 'Choose a food…'}
            </option>
            {foods?.map((f) => (
              <option key={f.id} value={f.name}>
                {f.name} ({f.servingQty} {f.servingUnit})
              </option>
            ))}
          </select>
          <input
            className="nt-input"
            type="number"
            min="0"
            step="0.1"
            value={row.quantity}
            onChange={(e) => {
              const next = [...rows];
              next[i] = { ...next[i]!, quantity: e.target.value };
              setRows(next);
            }}
          />
          <button
            className="nt-btn-ghost"
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
            disabled={rows.length === 1}
          >
            ✕
          </button>
        </div>
      ))}

      <div className="nt-field-row">
        <button
          className="nt-btn-ghost"
          onClick={() => setRows([...rows, { food: '', quantity: '1' }])}
        >
          + food
        </button>
        <button className="nt-btn" disabled={busy} onClick={submitAdHoc}>
          Log
        </button>
      </div>

      {error && <p className="nt-error">{error}</p>}
      {notice && <p className="muted small">{notice}</p>}
    </section>
  );
}
