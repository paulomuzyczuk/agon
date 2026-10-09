'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { WellnessLatestStat, WellnessResponse } from '@/lib/marts';
import { WellnessChart } from '@/components/WellnessChart';

// Wellness / recovery view (resting HR, HRV, sleep, active minutes). Read-only:
// fetches the zod-validated /api/wellness boundary rather than touching the DB,
// so the PWA never carries server code or a connection string. Writes stay in the
// gh:wellness ingestion path. Signals are sparse — gaps render as gaps.

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: WellnessResponse };

export default function WellnessPage() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    fetch('/api/wellness?days=60')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<WellnessResponse>;
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

  const hasData =
    state.kind === 'ready' && state.data.series.some((p) => hasAnyReading(p));

  return (
    <main className="page">
      <header className="page-head">
        <Link href="/" className="back">
          ← Agon
        </Link>
        <h1>Wellness &amp; recovery</h1>
        <p className="sub">Resting HR · HRV · sleep — last 60 days</p>
      </header>

      {state.kind === 'loading' && <p className="muted">Loading…</p>}
      {state.kind === 'error' && (
        <p className="muted">Couldn’t load wellness ({state.message}).</p>
      )}

      {state.kind === 'ready' && hasData && (
        <>
          <section className="stat-row">
            <Stat
              label="Resting HR"
              stat={state.data.latest.restingHr}
              unit="bpm"
            />
            <Stat label="HRV" stat={state.data.latest.hrvRmssd} unit="ms" />
            <Stat
              label="Sleep"
              stat={state.data.latest.sleepHours}
              unit="h"
              digits={1}
            />
          </section>

          <section className="card" style={{ marginTop: '1rem' }}>
            <WellnessChart series={state.data.series} />
          </section>

          <p className="muted small" style={{ marginTop: '1rem' }}>
            Recovery signals over time, on a shared day axis so they read against
            training load. Resting HR and HRV come from the Fitbit Air (Google
            Health); sleep is summed over each night’s sessions. The three feeds
            are sparse and don’t all land on the same day — gaps in a line are
            missing readings, not zeros. Each “latest” stat is that metric’s most
            recent reading, which may be from a different day than the others.
          </p>
        </>
      )}

      {state.kind === 'ready' && !hasData && (
        <p className="muted">No wellness data yet.</p>
      )}
    </main>
  );
}

function hasAnyReading(p: WellnessResponse['series'][number]): boolean {
  return (
    p.restingHr != null ||
    p.hrvRmssd != null ||
    p.sleepMinutes != null ||
    p.sleepEfficiency != null ||
    p.activeMinutes != null
  );
}

function Stat({
  label,
  stat,
  unit,
  digits = 0,
}: {
  label: string;
  stat: WellnessLatestStat | null;
  unit: string;
  digits?: number;
}) {
  return (
    <div className="stat">
      <div className="stat-value">
        {stat != null ? (
          <>
            {stat.value.toFixed(digits)}
            <span className="stat-unit"> {unit}</span>
          </>
        ) : (
          '—'
        )}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
