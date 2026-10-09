'use client';

import { useState } from 'react';
import { fmtDurationS } from '@/lib/activityCorrection';
import type { StopSuggestionView } from '@/lib/missedStopDetection';

// An open missed-stop suggestion (MZY-254) on the run/ride detail page: the
// recording seems to have kept running after the athlete stopped. One tap
// applies the MZY-253 late-stop trim; "Keep as is" dismisses it for good.

export function StopSuggestionCard({
  kind,
  suggestion,
  onChanged,
}: {
  kind: 'run' | 'ride';
  suggestion: StopSuggestionView;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = suggestion;

  async function resolve(action: 'apply' | 'dismiss') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/missed-stops/${s.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        status?: string;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.status === 'stale') {
        setError(
          'This activity changed since it was flagged — nothing trimmed.',
        );
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  const tail = `${fmtDurationS(s.trimS)} (${Math.round(s.distanceKm * 1000)} m, ${s.movingS} s moving)`;
  return (
    <section className="card stop-suggestion" style={{ marginTop: '1rem' }}>
      <p className="small" style={{ margin: 0 }}>
        {s.confidence === 'home'
          ? `🏠 The recording seems to have kept running after you got home — the last ${tail}.`
          : `📍 This ${kind} ends in a slow tail away from home — the last ${tail}. Forgot to stop it?`}
      </p>
      {error && <p className="nt-error">{error}</p>}
      <div className="nt-field-row">
        <button
          className="nt-btn"
          disabled={busy}
          onClick={() => resolve('apply')}
        >
          Trim it
        </button>
        <button
          className="nt-btn-ghost"
          disabled={busy}
          onClick={() => resolve('dismiss')}
        >
          Keep as is
        </button>
      </div>
    </section>
  );
}
