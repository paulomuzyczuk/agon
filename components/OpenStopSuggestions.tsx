'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { fmtDurationS } from '@/lib/activityCorrection';
import type { OpenStopSuggestionsResponse } from '@/lib/missedStopDetection';

// Dashboard strip for open missed-stop suggestions (MZY-254): each links to
// the run/ride page where "Trim it" / "Keep as is" live. Renders nothing when
// there are none (or the fetch fails — it is a hint, the page works without).

export function OpenStopSuggestions() {
  const [items, setItems] = useState<
    OpenStopSuggestionsResponse['suggestions']
  >([]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/missed-stops')
      .then((r) =>
        r.ok ? (r.json() as Promise<OpenStopSuggestionsResponse>) : null,
      )
      .then((data) => {
        if (!cancelled && data) setItems(data.suggestions);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      {items.map((s) => (
        <Link key={s.id} href={s.href} className="tile">
          <h2>
            Recording left running?{' '}
            <span className="tile-badge">
              {s.confidence === 'home' ? 'home' : 'away'}
            </span>
          </h2>
          <p>
            Your {s.kind} on {s.date} may end with {fmtDurationS(s.trimS)} of
            idle tail — review &amp; trim
          </p>
        </Link>
      ))}
    </>
  );
}
