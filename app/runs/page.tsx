'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { RunsResponse } from '@/lib/marts';
import { RunsList } from '@/components/RunsList';

// Recent-runs view. Read-only: fetches the zod-validated /api/runs boundary
// rather than touching the DB. Each row links to /runs/[id] for the full
// stream/route detail.

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: RunsResponse };

export default function RunsPage() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    fetch('/api/runs?limit=50')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<RunsResponse>;
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
        <h1>Runs</h1>
        <p className="sub">Recent runs · distance, pace, HR, weather, Relative Effort</p>
      </header>

      {state.kind === 'loading' && <p className="muted">Loading…</p>}
      {state.kind === 'error' && (
        <p className="muted">Couldn’t load runs ({state.message}).</p>
      )}

      {state.kind === 'ready' && (
        <section className="card">
          <RunsList runs={state.data.runs} />
        </section>
      )}
    </main>
  );
}
