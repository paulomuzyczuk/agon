'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { RelativeEffortResponse } from '@/lib/marts';
import { RelativeEffortList } from '@/components/RelativeEffortList';

// Per-run Relative Effort view (Banister TRIMP). Read-only: fetches the
// zod-validated /api/relative-effort boundary rather than touching the DB. The
// `method` per run is surfaced so stream-integrated scores are visibly more
// certain than avg-HR / pace-estimated ones.

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: RelativeEffortResponse };

export default function RelativeEffortPage() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    fetch('/api/relative-effort?limit=30')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<RelativeEffortResponse>;
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
        <h1>Relative Effort</h1>
        <p className="sub">Per-run training load · Banister TRIMP</p>
      </header>

      {state.kind === 'loading' && <p className="muted">Loading…</p>}
      {state.kind === 'error' && (
        <p className="muted">Couldn’t load relative effort ({state.message}).</p>
      )}

      {state.kind === 'ready' && state.data.runs.length > 0 && (
        <>
          <section className="card">
            <RelativeEffortList runs={state.data.runs} />
          </section>

          <p className="muted small" style={{ marginTop: '1rem' }}>
            Relative Effort is a per-session training-load score (Banister TRIMP)
            — higher = harder, weighting heart rate relative to max by duration.
            The daily sum feeds the Fitness/Fatigue/Form curve. Method:{' '}
            <strong style={{ color: '#4ade80' }}>stream</strong> integrates the
            full HR series (most accurate);{' '}
            <strong style={{ color: '#f5b74a' }}>avg HR</strong> uses the session
            average; <strong style={{ color: '#f97362' }}>est. pace</strong> has
            no HR and is inferred from pace — treat it as a rough estimate.
          </p>
        </>
      )}

      {state.kind === 'ready' && state.data.runs.length === 0 && (
        <p className="muted">No scored runs yet.</p>
      )}
    </main>
  );
}
