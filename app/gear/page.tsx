'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { GearResponse } from '@/lib/rideMarts';
import { GearList } from '@/components/GearList';

// Gear mileage view — total km per shoe/bike/etc.

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: GearResponse };

export default function GearPage() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    fetch('/api/gear')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<GearResponse>;
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
        <h1>Gear</h1>
        <p className="sub">
          Total mileage per shoe, bike, and other tracked gear
        </p>
      </header>

      {state.kind === 'loading' && <p className="muted">Loading…</p>}
      {state.kind === 'error' && (
        <p className="muted">Couldn’t load gear ({state.message}).</p>
      )}

      {state.kind === 'ready' && (
        <section className="card">
          <GearList gear={state.data.gear} />
        </section>
      )}
    </main>
  );
}
