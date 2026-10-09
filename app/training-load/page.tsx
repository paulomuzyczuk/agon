'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { TrainingLoadResponse } from '@/lib/marts';
import {
  TrainingLoadChart,
  FormBadge,
} from '@/components/TrainingLoadChart';

// Training-load view (Fitness / Fatigue / Form). Read-only: fetches the
// zod-validated /api/training-load boundary rather than touching the DB, so the
// PWA never carries server code or a connection string. Writes stay in Telegram
// + the ingestion scripts.

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: TrainingLoadResponse };

export default function TrainingLoadPage() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    fetch('/api/training-load?days=90')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<TrainingLoadResponse>;
      })
      .then((data) => live && setState({ kind: 'ready', data }))
      .catch(
        (err) =>
          live &&
          setState({ kind: 'error', message: err.message ?? 'failed' }),
      );
    return () => {
      live = false;
    };
  }, []);

  return (
    <main className="page">
      <header className="page-head">
        <Link href="/" className="back">
          ← Agon
        </Link>
        <h1>Training load</h1>
        <p className="sub">Fitness · Fatigue · Form — last 90 days</p>
      </header>

      {state.kind === 'loading' && <p className="muted">Loading…</p>}
      {state.kind === 'error' && (
        <p className="muted">Couldn’t load training load ({state.message}).</p>
      )}

      {state.kind === 'ready' && state.data.latest && (
        <>
          <section className="stat-row">
            <Stat label="Fitness (CTL)" value={state.data.latest.ctl} />
            <Stat label="Fatigue (ATL)" value={state.data.latest.atl} />
            <Stat
              label="Form (TSB)"
              value={state.data.latest.tsb}
              signed
            />
          </section>

          <div style={{ margin: '0.5rem 0 1rem' }}>
            <FormBadge
              tsb={state.data.latest.tsb}
              zone={state.data.latest.formZone}
            />
          </div>

          <section className="card">
            <TrainingLoadChart series={state.data.series} />
          </section>

          <p className="muted small">
            CTL = 42-day fitness average, ATL = 7-day fatigue average, TSB =
            CTL − ATL (form). Negative form means building/fatigued; positive
            means fresh or detraining.
          </p>
        </>
      )}

      {state.kind === 'ready' && !state.data.latest && (
        <p className="muted">No training-load data yet.</p>
      )}
    </main>
  );
}

function Stat({
  label,
  value,
  signed,
}: {
  label: string;
  value: number;
  signed?: boolean;
}) {
  return (
    <div className="stat">
      <div className="stat-value">
        {signed && value > 0 ? '+' : ''}
        {value.toFixed(0)}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
