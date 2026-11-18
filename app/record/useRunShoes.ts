'use client';

import { useEffect, useState } from 'react';
import type { RunShoe, RunShoesResponse } from '@/lib/runShoes';

// The shoes for the Save form's dropdown, loaded once. A failed load is not an
// error for the athlete: the run can still be saved, just without a shoe (it
// can be set later), so this resolves to an empty list and says why.

export type RunShoesState =
  | { kind: 'loading' }
  | { kind: 'ready'; shoes: RunShoe[] }
  | { kind: 'unavailable' };

export function useRunShoes(enabled: boolean): RunShoesState {
  const [state, setState] = useState<RunShoesState>({ kind: 'loading' });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch('/api/gear/shoes')
      .then((res) => {
        if (!res.ok) throw new Error(`shoes ${res.status}`);
        return res.json() as Promise<RunShoesResponse>;
      })
      .then((body) => {
        if (!cancelled) setState({ kind: 'ready', shoes: body.shoes });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'unavailable' });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}
