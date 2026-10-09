'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { RunComplianceResponse } from '@/lib/marts';
import { RunComplianceList } from '@/components/RunComplianceList';

// Weekly run-compliance view. Read-only: fetches the zod-validated
// /api/run-compliance boundary over analytics.fct_run_compliance_weekly.

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: RunComplianceResponse };

export default function RunCompliancePage() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    fetch('/api/run-compliance')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<RunComplianceResponse>;
      })
      .then((data) => live && setState({ kind: 'ready', data }))
      .catch(
        (err) => live && setState({ kind: 'error', message: err.message ?? 'failed' }),
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
        <h1>Run compliance</h1>
        <p className="sub">Weekly km vs. plan · easy-run HR-cap adherence</p>
      </header>

      {state.kind === 'loading' && <p className="muted">Loading…</p>}
      {state.kind === 'error' && (
        <p className="muted">Couldn’t load run compliance ({state.message}).</p>
      )}

      {state.kind === 'ready' && (
        <>
          <section className="card">
            <RunComplianceList weeks={state.data.weeks} />
          </section>
          <p className="muted small" style={{ marginTop: '1rem' }}>
            Km compares actual logged distance to the training program&rsquo;s planned
            weekly km. HR compares each easy-run day&rsquo;s average HR to that day&rsquo;s
            planned cap (only days the plan actually caps — CLAUDE.md Block 1: no
            HR spikes above 154 bpm on easy days) — a simple average-HR read, not
            yet a stream-level time-in-zone one. ≥90% green, 70–89% amber, &lt;70%
            red; the tick marks 100%.
          </p>
        </>
      )}
    </main>
  );
}
