'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { BodyCompLatestStat, BodyCompResponse } from '@/lib/marts';
import { BodyCompChart } from '@/components/BodyCompChart';

// Body-composition view (weight, body fat %). Read-only: fetches the
// zod-validated /api/body-comp boundary rather than touching the DB, so the PWA
// never carries server code or a connection string. Writes stay in Telegram
// (/weight, /bf). Weigh-ins are sparse (roughly monthly) — gaps render as gaps,
// and the whole history is shown rather than a fixed day window.

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: BodyCompResponse };

export default function BodyCompPage() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    fetch('/api/body-comp')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<BodyCompResponse>;
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

  const hasData = state.kind === 'ready' && state.data.series.length > 0;

  return (
    <main className="page">
      <header className="page-head">
        <Link href="/" className="back">
          ← Agon
        </Link>
        <h1>Body composition</h1>
        <p className="sub">Weight &amp; body fat since training start</p>
      </header>

      {state.kind === 'loading' && <p className="muted">Loading…</p>}
      {state.kind === 'error' && (
        <p className="muted">Couldn’t load body composition ({state.message}).</p>
      )}

      {state.kind === 'ready' && hasData && (
        <>
          <section className="stat-row">
            <Stat
              label="Weight"
              stat={state.data.latest.weightKg}
              unit="kg"
              digits={1}
              startingValue={state.data.startingWeightKg}
            />
            <Stat
              label="Body fat"
              stat={state.data.latest.bodyFatPct}
              unit="%"
              digits={1}
              startingValue={state.data.startingBodyFatPct}
            />
          </section>

          <section className="card" style={{ marginTop: '1rem' }}>
            <BodyCompChart series={state.data.series} />
          </section>

          <p className="muted small" style={{ marginTop: '1rem' }}>
            Weight and body fat as logged via Telegram (/weight, /bf). Weigh-ins
            are sparse and irregular (roughly monthly) — gaps in a line are
            missing readings, not zeros. Each “latest” stat is that metric’s
            most recent reading, which may be from a different day than the
            other. “Since start” compares against the Athlete Profile’s
            training-start figures ({state.data.startingWeightKg} kg,{' '}
            {state.data.startingBodyFatPct}% BF, 23 Mar 2026).
          </p>
        </>
      )}

      {state.kind === 'ready' && !hasData && (
        <p className="muted">No body-composition data yet.</p>
      )}
    </main>
  );
}

function Stat({
  label,
  stat,
  unit,
  digits = 0,
  startingValue,
}: {
  label: string;
  stat: BodyCompLatestStat | null;
  unit: string;
  digits?: number;
  startingValue: number;
}) {
  const sinceStart = stat != null ? stat.value - startingValue : null;
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
      {sinceStart != null && (
        <div
          className="muted small"
          style={{ color: sinceStart <= 0 ? '#4ade80' : '#f97362' }}
        >
          {sinceStart > 0 ? '+' : ''}
          {sinceStart.toFixed(digits)} {unit} since start
        </div>
      )}
    </div>
  );
}
