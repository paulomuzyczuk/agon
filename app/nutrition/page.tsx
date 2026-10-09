'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type {
  NutritionResponse,
  MealTemplateSummary,
  GoalRange,
} from '@/lib/marts';
import { MealLogForm } from '@/components/MealLogForm';
import { MealLogList } from '@/components/MealLogList';
import { onOutboxDelivered } from '@/lib/outbox';
import { useReplica } from '@/lib/sync/useReplica';
import { mealLogsView, type FoodMacros } from '@/lib/sync/views';

// Nutrition view: today's water/kcal/creatine/supplement goals, plus meal
// logging against the foods catalog + usual-meal templates (interim, ahead of
// the Cronometer CSV import — CLAUDE.md "Nutrition" decision 2026-08-24).
// Read side fetches the zod-validated /api/nutrition boundary; the log form
// posts to /api/nutrition/log. `nutritionDay` (a future Cronometer import)
// takes over the "logged intake" display once meal_logs has nothing for a day.

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: NutritionResponse };

export default function NutritionPage() {
  const [fetched, setState] = useState<State>({ kind: 'loading' });
  const [foods, setFoods] = useState<FoodMacros[] | null>(null);
  // Local-first (MZY-207): goals/water/templates come from /api/nutrition
  // (reference data, served from the service-worker cache offline); the
  // athlete-authored meals and their totals come from the device replica
  // once it is hydrated — so offline edits and other devices' synced meals
  // show without a server round-trip.
  const replica = useReplica();
  const state: State =
    fetched.kind === 'ready' &&
    replica.status.hydrated &&
    replica.tables &&
    foods
      ? {
          kind: 'ready',
          data: {
            ...fetched.data,
            ...mealLogsView(
              replica.tables,
              fetched.data.date,
              foods,
              new Map(fetched.data.mealTemplates.map((t) => [t.id, t.name])),
            ),
          },
        }
      : fetched;

  useEffect(() => {
    fetch('/api/nutrition/foods')
      .then((r) =>
        r.ok ? (r.json() as Promise<{ foods: FoodMacros[] }>) : null,
      )
      .then((d) => d && setFoods(d.foods))
      .catch(() => undefined);
  }, []);

  // null = the server's "today" in the athlete's zone.
  const [day, setDay] = useState<string | null>(null);
  const [today, setToday] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(day ? `/api/nutrition?date=${day}` : '/api/nutrition')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<NutritionResponse>;
      })
      .then((data) => {
        setState({ kind: 'ready', data });
        if (!day) setToday(data.date);
      })
      // Offline: keep what we had. For another day, keep the goals/templates
      // (reference data) and move the date — its meals come from the replica.
      .catch((err) =>
        setState((prev) =>
          prev.kind === 'ready'
            ? day
              ? { kind: 'ready', data: { ...prev.data, date: day } }
              : prev
            : { kind: 'error', message: err.message ?? 'failed' },
        ),
      );
  }, [day]);

  const shift = (days: number) => {
    if (fetched.kind !== 'ready') return;
    const d = new Date(`${fetched.data.date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    const next = d.toISOString().slice(0, 10);
    setDay(next === today ? null : next);
  };

  useEffect(() => {
    load();
    return onOutboxDelivered(load);
  }, [load]);

  return (
    <main className="page">
      <header className="page-head">
        <Link href="/" className="back">
          ← Agon
        </Link>
        <h1>Nutrition</h1>
        <p className="sub">
          {state.kind === 'ready' ? (
            <>
              Water, supplements & usual meals —{' '}
              <button
                className="ob-link"
                aria-label="Previous day"
                onClick={() => shift(-1)}
              >
                ‹
              </button>{' '}
              {state.data.date}{' '}
              <button
                className="ob-link"
                aria-label="Next day"
                disabled={!!today && state.data.date >= today}
                onClick={() => shift(1)}
              >
                ›
              </button>
            </>
          ) : (
            'Water, supplements & usual meals'
          )}
        </p>
      </header>

      {state.kind === 'loading' && <p className="muted">Loading…</p>}
      {state.kind === 'error' && (
        <p className="muted">Couldn’t load nutrition ({state.message}).</p>
      )}

      {state.kind === 'ready' && (
        <>
          <section className="nt-goal-grid">
            <div className="stat">
              <div className="stat-value">
                {state.data.water.goalL.toFixed(1)}
                <span className="stat-unit"> L</span>
              </div>
              <div className="stat-label">Water goal</div>
            </div>
            {state.data.kcalGoal && (
              <RangeTile label="Calories" range={state.data.kcalGoal} />
            )}
            {state.data.proteinGoal && (
              <RangeTile label="Protein" range={state.data.proteinGoal} />
            )}
            {state.data.carbsGoal && (
              <RangeTile label="Carbs" range={state.data.carbsGoal} />
            )}
            {state.data.fatGoal && (
              <RangeTile label="Fat" range={state.data.fatGoal} />
            )}
            {state.data.creatineGoal && (
              <RangeTile label="Creatine" range={state.data.creatineGoal} />
            )}
            {state.data.supplementGoals.map((g) => (
              <div className="stat" key={g.goalKey}>
                <div className="stat-value">
                  {g.value}
                  <span className="stat-unit"> {g.unit}</span>
                </div>
                <div className="stat-label">{labelFor(g.goalKey)}</div>
              </div>
            ))}
          </section>
          <p className="nt-water-note">
            {state.data.water.exerciseLossL > 0
              ? `${state.data.water.baseL} L base + ${state.data.water.exerciseLossL.toFixed(2)} L estimated from today's planned exercise.`
              : `${state.data.water.baseL} L base — no exercise-driven addition today.`}
          </p>

          <section className="card" style={{ marginTop: '1rem' }}>
            <h2 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>
              Today’s logged intake
            </h2>
            <IntakeSummary data={state.data} />
            <div style={{ marginTop: '0.5rem' }}>
              <MealLogList logs={state.data.todaysMealLogs} onChanged={load} />
            </div>
          </section>

          <MealLogForm
            date={state.data.date}
            templates={state.data.mealTemplates}
            onLogged={load}
          />

          <section className="card" style={{ marginTop: '1rem' }}>
            <h2 style={{ margin: '0 0 0.25rem', fontSize: '0.95rem' }}>
              Usual meals
            </h2>
            <ul className="nt-meal-list">
              {state.data.mealTemplates.map((t) => (
                <MealTemplateRow key={t.id} t={t} />
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}

function RangeTile({ label, range }: { label: string; range: GoalRange }) {
  return (
    <div className="stat">
      <div className="stat-value" style={{ fontSize: '1.15rem' }}>
        {range.min}–{range.max}
        <span className="stat-unit"> {range.unit}</span>
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function IntakeSummary({ data }: { data: NutritionResponse }) {
  const totals = displayedIntake(data);
  if (!totals) {
    return (
      <p className="muted small">
        Nothing logged for today. Daily intake is tracked in Cronometer once
        that import lands, or log below meanwhile.
      </p>
    );
  }
  return (
    <p className="small">
      <MacroValue value={totals.kcal} unit="kcal" goal={data.kcalGoal} /> ·{' '}
      <MacroValue
        value={totals.proteinG}
        unit="g protein"
        goal={data.proteinGoal}
      />{' '}
      ·{' '}
      <MacroValue value={totals.carbsG} unit="g carbs" goal={data.carbsGoal} />{' '}
      · <MacroValue value={totals.fatG} unit="g fat" goal={data.fatGoal} />
    </p>
  );
}

/** A logged value, colored under/in-range/over when a target range is known. */
function MacroValue({
  value,
  unit,
  goal,
}: {
  value: number;
  unit: string;
  goal: GoalRange | null;
}) {
  const color = goal ? rangeStatusColor(value, goal) : undefined;
  return (
    <span style={color ? { color } : undefined}>
      {value} {unit}
    </span>
  );
}

function rangeStatusColor(value: number, goal: GoalRange): string {
  if (value < goal.min) return '#f5b74a';
  if (value > goal.max) return '#f97362';
  return '#4ade80';
}

/**
 * What to show as "today's intake": structured meal_logs totals if any were
 * logged, else the coarse nutrition_days row (a future Cronometer import),
 * else nothing.
 */
function displayedIntake(
  data: NutritionResponse,
): NutritionResponse['loggedTotals'] | null {
  if (data.loggedTotals.kcal > 0) return data.loggedTotals;
  if (data.nutritionDay) return data.nutritionDay;
  return null;
}

function labelFor(goalKey: string): string {
  const known: Record<string, string> = {
    vitamin_c_mg: 'Vitamin C',
    zinc_mg: 'Zinc',
    vitamin_d_iu: 'Vitamin D',
  };
  return known[goalKey] ?? goalKey.replace(/_/g, ' ');
}

function MealTemplateRow({ t }: { t: MealTemplateSummary }) {
  return (
    <li className="nt-meal-row">
      <div className="nt-meal-head">
        <span className="nt-meal-name">{t.name}</span>
        {t.block != null && (
          <span className="nt-meal-tag">Block {t.block}</span>
        )}
      </div>
      <span className="nt-meal-macros">
        {t.totals.kcal} kcal · {t.totals.proteinG}g protein · {t.totals.carbsG}g
        carbs · {t.totals.fatG}g fat
      </span>
    </li>
  );
}
