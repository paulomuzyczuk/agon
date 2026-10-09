'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { listUnflushedRecordings } from '@/lib/liveRecordingDb';

// The dashboard's entry to the recorder (MZY-287). The Android shell has no
// address bar, so without this tile /record is unreachable in the app. A
// badge counts recordings still in this device's IndexedDB buffer (a crash or
// an offline Stop) — the same list app/record shows as "unfinished
// recordings" — so one isn't forgotten.

export function RecordTile() {
  const [unfinished, setUnfinished] = useState(0);

  useEffect(() => {
    if (typeof indexedDB === 'undefined') return;
    let cancelled = false;
    listUnflushedRecordings()
      .then((all) => {
        if (!cancelled) setUnfinished(all.length);
      })
      .catch(() => {}); // the badge is a hint; the tile works without it
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Link href="/record" className="tile">
      <h2>
        Record activity →
        {unfinished > 0 && (
          <>
            {' '}
            <span className="tile-badge">{unfinished} unfinished</span>
          </>
        )}
      </h2>
      <p>Run or ride with your heart-rate strap &amp; bike sensors</p>
    </Link>
  );
}
