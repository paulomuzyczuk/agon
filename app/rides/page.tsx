'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { RidesResponse } from '@/lib/rideMarts';
import { RidesList } from '@/components/RidesList';

// Recent-rides view. Mirrors app/runs/page.tsx.

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: RidesResponse };

export default function RidesPage() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    fetch('/api/rides?limit=50')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<RidesResponse>;
      })
      .then((data) => live && setState({ kind: 'ready', data }))
      .catch(
        (err) =>
          live && setState({ kind: 'error', message: err.message ?? 'failed' }),
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
        <h1>Rides</h1>
        <p className="sub">Recent bike rides · distance, speed, HR, weather</p>
      </header>

      {state.kind === 'loading' && <p className="muted">Loading…</p>}
      {state.kind === 'error' && (
        <p className="muted">Couldn’t load rides ({state.message}).</p>
      )}

      {state.kind === 'ready' && (
        <section className="card">
          <RidesList rides={state.data.rides} />
        </section>
      )}
    </main>
  );
}
