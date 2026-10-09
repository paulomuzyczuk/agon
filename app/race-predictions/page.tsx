'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { RacePredictionsResponse } from '@/lib/marts';
import { RacePredictionsTable } from '@/components/RacePredictionsTable';

// Race-predictions view. Read-only: fetches the /api/race-predictions boundary
// rather than touching the DB. Headline is a Riegel power law with the athlete's
// OWN recalibrated exponent; Daniels VDOT is reported as a cross-check. The 70k /
// marathon rows are extrapolations (flagged in the mart) and render with a wide
// band — never as a single confident number.

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: RacePredictionsResponse };

export default function RacePredictionsPage() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    fetch('/api/race-predictions')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<RacePredictionsResponse>;
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
        <h1>Race predictions</h1>
        <p className="sub">Predicted times · self-recalibrated Riegel</p>
      </header>

      {state.kind === 'loading' && <p className="muted">Loading…</p>}
      {state.kind === 'error' && (
        <p className="muted">Couldn’t load race predictions ({state.message}).</p>
      )}

      {state.kind === 'ready' && (
        <>
          <section className="card">
            <RacePredictionsTable predictions={state.data.predictions} />
          </section>

          {state.data.fit && (
            <section className="stat-row" style={{ marginTop: '1rem' }}>
              <FitStat
                label="Riegel k (self)"
                value={state.data.fit.fitK.toFixed(2)}
              />
              <FitStat
                label="Fit R²"
                value={state.data.fit.fitR2.toFixed(3)}
              />
              <FitStat
                label="Ref VDOT"
                value={
                  state.data.fit.refVdot != null
                    ? state.data.fit.refVdot.toFixed(0)
                    : '—'
                }
              />
            </section>
          )}

          <p className="muted small" style={{ marginTop: '1rem' }}>
            Headline uses a Riegel power law with the athlete’s{' '}
            <strong>own recalibrated exponent</strong>
            {state.data.fit && !state.data.fit.fitFallback ? (
              <>
                {' '}
                (k = {state.data.fit.fitK.toFixed(2)} from{' '}
                {state.data.fit.nPairs} best-effort pairs, vs the generic 1.06 —
                this athlete fades harder over distance)
              </>
            ) : (
              <> (fell back to the generic k = 1.06 — not enough best-effort pairs yet)</>
            )}
            . Daniels VDOT is a cross-check. The Marathon and 70K rows are{' '}
            <strong>extrapolations</strong> beyond the longest real effort —
            shown with a wide error band, never as a confident single number.
          </p>
        </>
      )}
    </main>
  );
}

function FitStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-value" style={{ fontSize: '1.3rem' }}>
        {value}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
