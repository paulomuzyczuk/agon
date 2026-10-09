'use client';

import Link from 'next/link';
import type { RacePrediction } from '@/lib/marts';

// Predicted race times — a compact, mobile-first table (no chart library). Each
// row shows the headline predicted time + derived pace; extrapolated rows
// (past the longest real effort) are visually flagged and carry a wider band so
// they never read as a single confident number. Below the prediction, a
// verified/realized line (from fct_run_best_efforts) shows the athlete's actual
// PR at that exact distance, colored by whether they've already beaten the
// model or the model still expects better than they've shown.

const COLORS = {
  band: '#8a919c',
  extrap: '#f5b74a', // amber — caution
  axis: '#6b7280',
  beatModel: '#4caf7d', // green — realized faster than predicted
  behindModel: '#8a919c', // neutral grey — realized slower than predicted
};

/** Seconds → `H:MM:SS` or `M:SS` (drops the hour when zero). */
function fmtTime(totalS: number): string {
  const s = Math.round(totalS);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Seconds-per-km → `M:SS /km`. */
function fmtPace(sPerKm: number): string {
  const s = Math.round(sPerKm);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss} /km`;
}

/** `YYYY-MM-DD` → `Mon D, YYYY` for the small verified-PR date line. */
function fmtDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function RacePredictionsTable({
  predictions,
}: {
  predictions: RacePrediction[];
}) {
  if (predictions.length === 0) {
    return <p style={{ color: COLORS.axis }}>No race predictions yet.</p>;
  }

  return (
    <ul className="pred-list">
      {predictions.map((p) => (
        <li key={p.label} className="pred-row">
          <div className="pred-dist">
            <span className="pred-label">{p.label}</span>
            {p.extrapolated && (
              <span className="pred-tag" title="Extrapolated beyond the longest real effort">
                extrapolated
              </span>
            )}
          </div>

          <div className="pred-figures">
            <div
              className="pred-time"
              style={p.extrapolated ? { color: COLORS.extrap } : undefined}
            >
              {p.extrapolated ? '~' : ''}
              {fmtTime(p.predictedS)}
            </div>
            <div className="pred-pace">{fmtPace(p.predictedPaceSPerKm)}</div>
            <div className="pred-band">
              {fmtTime(p.lowS)} – {fmtTime(p.highS)}
              <span className="pred-band-pct"> (±{(p.bandPct * 100).toFixed(0)}%)</span>
            </div>

            <VerifiedLine prediction={p} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function VerifiedLine({ prediction: p }: { prediction: RacePrediction }) {
  if (!p.verified) {
    return (
      <div className="pred-verified pred-verified-none">
        No verified PR yet
      </div>
    );
  }

  const beatModel = p.verified.elapsedTimeS < p.predictedS;
  const deltaS = Math.abs(p.verified.elapsedTimeS - p.predictedS);
  const time = fmtTime(p.verified.elapsedTimeS);

  const content = (
    <>
      <span
        className="pred-verified-time"
        style={{ color: beatModel ? COLORS.beatModel : COLORS.behindModel }}
      >
        {beatModel ? '✓ ' : ''}
        {time}
      </span>
      <span className="pred-verified-delta">
        {beatModel ? '−' : '+'}
        {fmtTime(deltaS)} vs. predicted
      </span>
      <span className="pred-verified-meta">
        {fmtDate(p.verified.achievedAt)}
        {p.verified.method === 'whole_run' ? ' · whole-run' : ''}
      </span>
    </>
  );

  return (
    <div className="pred-verified">
      {p.verified.prRunId ? (
        <Link href={`/runs/${p.verified.prRunId}`} className="pred-verified-link">
          {content}
        </Link>
      ) : (
        content
      )}
    </div>
  );
}
