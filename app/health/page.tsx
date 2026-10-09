'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type {
  HealthResponse,
  LabPanelSummary,
  LabResultTrendRow,
  RoutineSummary,
} from '@/lib/marts';
import { LabTrendChart } from '@/components/LabTrendChart';
import { GeneralHealthCreateForms } from '@/components/GeneralHealthCreateForms';
import { onOutboxDelivered } from '@/lib/outbox';
import { submitRows } from '@/lib/sync/client';
import { useReplica } from '@/lib/sync/useReplica';
import { healthView, labTrendsView } from '@/lib/sync/views';
import { routineDoneRows } from '@/lib/sync/entryRows';
import { todayISO } from '@/components/generalHealthForm';

// General health view: lab test results (out-of-range flags called out),
// skincare/dental routine adherence with a one-tap "done today" action, active
// medications/injuries/allergies, recent medical visits, and upcoming
// follow-ups/vaccinations. Read side fetches the zod-validated
// /api/general-health boundary (named distinctly from /api/health, the
// pre-existing liveness probe); the routine check-off posts to
// /api/general-health/log. Vision explicitly
// excluded per athlete direction (2026-08-24). Creation forms for the other
// domains (lab panels, medications, injuries, visits, vaccinations,
// conditions, routines) live in GeneralHealthCreateForms, posting to the same
// /api/general-health/log endpoint.

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: HealthResponse };

export default function HealthPage() {
  const [fetched, setState] = useState<State>({ kind: 'loading' });
  // Local-first (MZY-207): once this device holds the full replica, the page
  // renders from it — history offline, own writes instantly — and the fetch
  // below only matters before the first sync. Same shape either way
  // (lib/sync/views.ts, parity-tested against the server).
  const replica = useReplica();
  const state: State =
    replica.status.hydrated && replica.tables
      ? {
          kind: 'ready',
          data: healthView(
            replica.tables,
            new Date().toISOString().slice(0, 10),
          ),
        }
      : fetched;

  const load = useCallback(() => {
    fetch('/api/general-health')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<HealthResponse>;
      })
      .then((data) => setState({ kind: 'ready', data }))
      // Offline refresh after a queued write: keep showing what we had.
      .catch((err) =>
        setState((prev) =>
          prev.kind === 'ready'
            ? prev
            : { kind: 'error', message: err.message ?? 'failed' },
        ),
      );
  }, []);

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
        <h1>General health</h1>
        <p className="sub">Test results, routines, meds, injuries &amp; more</p>
      </header>

      {state.kind === 'loading' && <p className="muted">Loading…</p>}
      {state.kind === 'error' && (
        <p className="muted">Couldn’t load health data ({state.message}).</p>
      )}

      {state.kind === 'ready' && (
        <>
          <RoutinesSection data={state.data} onLogged={load} />
          <LabTrendsSection />
          <LabPanelsSection panels={state.data.recentLabPanels} />
          <InjuriesSection data={state.data} />
          <MedicationsSection data={state.data} />
          <ConditionsSection data={state.data} />
          <VisitsSection data={state.data} />
          <GeneralHealthCreateForms onCreated={load} />
        </>
      )}
    </main>
  );
}

function RoutinesSection({
  data,
  onLogged,
}: {
  data: HealthResponse;
  onLogged: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);

  const markDone = async (routineId: string) => {
    setPending(routineId);
    try {
      const name =
        data.routines.find((r) => r.id === routineId)?.name ?? 'routine';
      await submitRows({
        label: `Routine done: ${name}`,
        rows: routineDoneRows(routineId, todayISO(), () => crypto.randomUUID()),
      });
      onLogged();
    } finally {
      setPending(null);
    }
  };

  const adherenceFor = (id: string) =>
    data.routineAdherence.find((a) => a.routineId === id);

  return (
    <section className="card" style={{ marginTop: '1rem' }}>
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>
        Skincare &amp; dental routines
      </h2>
      {data.routines.length === 0 && (
        <p className="muted small">No routines set up yet.</p>
      )}
      <ul className="nt-meal-list">
        {data.routines.map((r) => (
          <RoutineRow
            key={r.id}
            routine={r}
            adherence={adherenceFor(r.id)}
            pending={pending === r.id}
            onMarkDone={() => markDone(r.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function RoutineRow({
  routine,
  adherence,
  pending,
  onMarkDone,
}: {
  routine: RoutineSummary;
  adherence: { loggedDays: number; completedDays: number } | undefined;
  pending: boolean;
  onMarkDone: () => void;
}) {
  return (
    <li className="nt-meal-row">
      <div className="nt-meal-head">
        <span className="nt-meal-name">
          {routine.name}
          {routine.timeOfDay && routine.timeOfDay !== 'any'
            ? ` (${routine.timeOfDay.toUpperCase()})`
            : ''}
        </span>
        <button
          type="button"
          className="nt-btn"
          disabled={pending}
          onClick={onMarkDone}
        >
          {pending ? '…' : 'Done today'}
        </button>
      </div>
      <span className="nt-meal-macros">
        {routine.steps.map((s) => s.product).join(' → ') || 'no steps set'}
      </span>
      <span className="muted small">
        Last 7 days:{' '}
        {adherence
          ? `${adherence.completedDays}/${adherence.loggedDays}`
          : '0/0'}
      </span>
    </li>
  );
}

/**
 * Cross-marker trend chart, fetched independently from /api/general-health
 * (which caps panels to the last 20) since a trend needs full history.
 * Mirrors sihha's PsychometricTrendCard sitting on the clinician dashboard as
 * its own data-fetching unit.
 */
function LabTrendsSection() {
  const [fetched, setResults] = useState<LabResultTrendRow[] | null>(null);
  const replica = useReplica();
  const results =
    replica.status.hydrated && replica.tables
      ? labTrendsView(replica.tables).results
      : fetched;

  useEffect(() => {
    fetch('/api/general-health/lab-trends')
      .then((r) =>
        r.ok ? (r.json() as Promise<{ results: LabResultTrendRow[] }>) : null,
      )
      .then((data) => setResults(data?.results ?? []))
      .catch(() => setResults([]));
  }, []);

  return (
    <section className="card" style={{ marginTop: '1rem' }}>
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>
        Lab results over time
      </h2>
      {results === null ? (
        <p className="muted small">Loading…</p>
      ) : (
        <LabTrendChart results={results} />
      )}
    </section>
  );
}

function LabPanelsSection({ panels }: { panels: LabPanelSummary[] }) {
  return (
    <section className="card" style={{ marginTop: '1rem' }}>
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>
        Recent test results
      </h2>
      {panels.length === 0 && (
        <p className="muted small">No lab panels logged yet.</p>
      )}
      {panels.map((p) => (
        <div key={p.id} style={{ marginBottom: '0.75rem' }}>
          <p className="small">
            <strong>{p.panelType}</strong> — {p.date}
            {p.labName ? ` (${p.labName})` : ''}
          </p>
          <ul className="nt-meal-list">
            {p.results.map((r, i) => (
              <li key={i} className="small" style={flagStyle(r.flag)}>
                {r.marker}:{' '}
                {r.valueNumeric != null
                  ? `${r.valueNumeric}${r.unit ? ` ${r.unit}` : ''}`
                  : r.valueText}
                {r.flag && r.flag !== 'normal' ? ` (${r.flag})` : ''}
                {r.needsReview && (
                  <span style={{ color: '#f5b74a' }}> · needs review</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function flagStyle(flag: string | null): { color: string } | undefined {
  if (flag === 'high' || flag === 'abnormal') return { color: '#f97362' };
  if (flag === 'low') return { color: '#f5b74a' };
  return undefined;
}

function InjuriesSection({ data }: { data: HealthResponse }) {
  return (
    <section className="card" style={{ marginTop: '1rem' }}>
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>
        Active injuries
      </h2>
      {data.activeInjuries.length === 0 && (
        <p className="muted small">None active.</p>
      )}
      <ul className="nt-meal-list">
        {data.activeInjuries.map((i) => (
          <li key={i.id} className="small">
            {i.bodyPart} — {i.status}
            {i.severity != null
              ? ` (severity ${i.severity}/10)`
              : ''} since {i.onsetDate}
          </li>
        ))}
      </ul>
    </section>
  );
}

function MedicationsSection({ data }: { data: HealthResponse }) {
  return (
    <section className="card" style={{ marginTop: '1rem' }}>
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>
        Active medications &amp; supplements
      </h2>
      {data.activeMedications.length === 0 && (
        <p className="muted small">None logged.</p>
      )}
      <ul className="nt-meal-list">
        {data.activeMedications.map((m) => (
          <li key={m.id} className="small">
            {m.name} ({m.kind}){m.dosage ? ` — ${m.dosage}` : ''}
            {m.schedule ? `, ${m.schedule}` : ''}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ConditionsSection({ data }: { data: HealthResponse }) {
  return (
    <section className="card" style={{ marginTop: '1rem' }}>
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>
        Allergies &amp; chronic conditions
      </h2>
      {data.healthConditions.length === 0 && (
        <p className="muted small">None logged.</p>
      )}
      <ul className="nt-meal-list">
        {data.healthConditions.map((c) => (
          <li key={c.id} className="small">
            {c.name} ({c.conditionType.replace('_', ' ')})
            {c.severity ? ` — ${c.severity}` : ''}
          </li>
        ))}
      </ul>
    </section>
  );
}

function VisitsSection({ data }: { data: HealthResponse }) {
  return (
    <section className="card" style={{ marginTop: '1rem' }}>
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>
        Medical visits &amp; upcoming follow-ups
      </h2>
      {data.upcomingFollowUps.length > 0 && (
        <>
          <p className="small">
            <strong>Upcoming:</strong>
          </p>
          <ul className="nt-meal-list">
            {data.upcomingFollowUps.map((f, i) => (
              <li key={i} className="small">
                {f.what} — due {f.due}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="small" style={{ marginTop: '0.5rem' }}>
        <strong>Recent visits:</strong>
      </p>
      {data.recentMedicalVisits.length === 0 && (
        <p className="muted small">None logged.</p>
      )}
      <ul className="nt-meal-list">
        {data.recentMedicalVisits.map((v) => (
          <li key={v.id} className="small">
            {v.date} — {v.visitType}
            {v.provider ? ` (${v.provider})` : ''}
            {v.findings ? `: ${v.findings}` : ''}
          </li>
        ))}
      </ul>
    </section>
  );
}
