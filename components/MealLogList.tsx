'use client';

import { useState } from 'react';
import type { MealLogSummary } from '@/lib/marts';
import { submitRows } from '@/lib/sync/client';
import { deleteRows } from '@/lib/sync/entryRows';
import { MealLogEditor } from './MealLogEditor';

// Today's logged meals (structured, food-level), with edit + undo per row.

export function MealLogList({
  logs,
  onChanged,
}: {
  logs: MealLogSummary[];
  onChanged: () => void;
}) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Through the outbox (MZY-205): an undo made offline is kept and delivered
  // later, strictly after any queued write before it. A tombstone since
  // MZY-206, so the undo replicates to the athlete's other devices.
  async function remove(log: MealLogSummary) {
    setDeletingId(log.id);
    try {
      const result = await submitRows({
        label: `Undo meal: ${log.mealSlot.replace('_', ' ')}`,
        rows: deleteRows('meal_logs', log.id, new Date().toISOString()),
      });
      if (result.state !== 'rejected') onChanged();
    } finally {
      setDeletingId(null);
    }
  }

  if (logs.length === 0) {
    return (
      <p className="muted small">
        Nothing logged for today yet — use the form below, or wait for the
        Cronometer import.
      </p>
    );
  }

  return (
    <ul className="nt-meal-list">
      {logs.map((log) =>
        editingId === log.id ? (
          <li className="nt-log-row" key={log.id}>
            <MealLogEditor
              log={log}
              onDone={(saved) => {
                setEditingId(null);
                if (saved) onChanged();
              }}
            />
          </li>
        ) : (
          <li className="nt-log-row" key={log.id}>
            <div className="nt-log-meta">
              <span className="nt-log-slot">
                {log.mealSlot.replace('_', ' ')}
              </span>
              <span className="nt-log-items">
                {log.templateName ? `${log.templateName} — ` : ''}
                {log.items
                  .map((i) => `${i.foodName} ×${i.quantity}`)
                  .join(', ')}
              </span>
              <span className="nt-log-items">
                {log.totals.kcal} kcal · {log.totals.proteinG}g protein ·{' '}
                {log.totals.carbsG}g carbs · {log.totals.fatG}g fat
              </span>
              {log.notes && <span className="nt-log-items">“{log.notes}”</span>}
            </div>
            <div className="ob-actions">
              <button
                className="nt-btn-ghost"
                onClick={() => setEditingId(log.id)}
              >
                Edit
              </button>
              <button
                className="nt-btn-ghost"
                disabled={deletingId === log.id}
                onClick={() => remove(log)}
              >
                Undo
              </button>
            </div>
          </li>
        ),
      )}
    </ul>
  );
}
