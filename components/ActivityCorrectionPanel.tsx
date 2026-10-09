'use client';

import { useState } from 'react';
import {
  fmtDurationS,
  fmtPace,
  type ActivityCorrectionState,
  type CorrectionActivityKind,
  type CorrectionPreview,
  type CorrectionRequest,
  type RevertGroup,
} from '@/lib/activityCorrection';

// Hand corrections on the run/ride detail pages (MZY-253): missed start,
// late stop, or plain totals, previewed before → after, then saved through
// PATCH /api/{runs,rides}/:id. Same panel for both activity kinds — runs show
// pace, rides show speed. Also lists what's corrected and offers the revert.

type Mode = CorrectionRequest['kind'];

const MODES: Array<{ mode: Mode; label: string }> = [
  { mode: 'missed_start', label: 'Missed start' },
  { mode: 'late_stop', label: 'Late stop' },
  { mode: 'totals', label: 'Edit totals' },
];

const FIELD_LABELS: Record<string, string> = {
  distance_km: 'distance',
  duration_s: 'moving time',
  avg_pace_s_per_km: 'pace',
  avg_speed_kmh: 'speed',
  started_at: 'start time',
  date: 'date',
  block: 'block',
  week: 'week',
};

/** m:ss or h:mm:ss → seconds; null when unparseable. */
function parseDuration(text: string): number | null {
  const parts = text.trim().split(':').map(Number);
  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some((n) => !Number.isFinite(n) || n < 0)
  ) {
    return null;
  }
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function fmtRate(kind: CorrectionActivityKind, v: number | null): string {
  if (v == null) return '—';
  return kind === 'run' ? fmtPace(v) : `${v.toFixed(2)} km/h`;
}

function fmtStart(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function CorrectedBadge() {
  return (
    <span className="corrected-badge" title="Hand-corrected — survives re-sync">
      corrected
    </span>
  );
}

export function ActivityCorrectionPanel({
  kind,
  id,
  correction,
  distanceKm,
  durationS,
  onChanged,
}: {
  kind: CorrectionActivityKind;
  id: string;
  correction: ActivityCorrectionState;
  distanceKm: number | null;
  durationS: number | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('missed_start');
  const [addKm, setAddKm] = useState('');
  const [trimMin, setTrimMin] = useState('');
  const [totKm, setTotKm] = useState(
    distanceKm != null ? distanceKm.toFixed(3) : '',
  );
  const [totTime, setTotTime] = useState(
    durationS != null ? fmtDurationS(durationS) : '',
  );
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<CorrectionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const endpoint = `/api/${kind}s/${id}`;
  const fields = correction.correctedFields;
  const startCorrected = fields.includes('started_at');
  const totalsCorrected = fields.some(
    (f) => !['started_at', 'date', 'block', 'week'].includes(f),
  );

  function request(): CorrectionRequest | string {
    if (mode === 'missed_start') {
      const km = Number(addKm);
      return km > 0
        ? { kind: mode, addKm: km }
        : 'Enter the missed distance in km.';
    }
    if (mode === 'late_stop') {
      const min = Number(trimMin);
      return min > 0
        ? { kind: mode, trimMin: min }
        : 'Enter the minutes to trim.';
    }
    const km = Number(totKm);
    const s = parseDuration(totTime);
    if (!(km > 0)) return 'Enter a distance in km.';
    if (s == null || s <= 0) return 'Enter moving time as m:ss or h:mm:ss.';
    return { kind: mode, distanceKm: km, durationS: s };
  }

  async function send(body: unknown): Promise<unknown> {
    const res = await fetch(endpoint, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  function onPreview() {
    const r = request();
    if (typeof r === 'string') return setError(r);
    void run(async () => {
      setPreview(
        (await send({
          action: 'correct',
          corrections: [r],
          dryRun: true,
        })) as CorrectionPreview,
      );
    });
  }

  function onSave() {
    const r = request();
    if (typeof r === 'string') return setError(r);
    void run(async () => {
      await send({
        action: 'correct',
        corrections: [r],
        note: note || undefined,
      });
      setPreview(null);
      setAddKm('');
      setTrimMin('');
      setNote('');
      setOpen(false);
      onChanged();
    });
  }

  function onRevert(group: RevertGroup) {
    void run(async () => {
      await send({ action: 'revert', group });
      onChanged();
    });
  }

  // Any input change invalidates the preview — Save only saves what was shown.
  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPreview(null);
    };

  const p = preview?.plan;
  return (
    <section className="card" style={{ marginTop: '1rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <h2 style={{ margin: 0, fontSize: '0.95rem' }}>Corrections</h2>
        {!open && (
          <button className="nt-btn-ghost" onClick={() => setOpen(true)}>
            Correct this {kind}
          </button>
        )}
      </div>

      {fields.length > 0 && (
        <div className="small" style={{ marginTop: '0.5rem' }}>
          <span className="muted">
            Corrected: {fields.map((f) => FIELD_LABELS[f] ?? f).join(', ')}.
          </span>
          <div className="nt-field-row">
            {totalsCorrected && (
              <button
                className="nt-btn-ghost"
                disabled={busy}
                onClick={() => onRevert('totals')}
              >
                Revert totals to source (on next sync)
              </button>
            )}
            {startCorrected && (
              <button
                className="nt-btn-ghost"
                disabled={busy}
                onClick={() => onRevert('start')}
              >
                Restore source start ({fmtStart(correction.sourceStartedAt)})
              </button>
            )}
          </div>
        </div>
      )}

      {open && (
        <div className="hc-form">
          <div className="hc-type-row">
            {MODES.map((m) => (
              <button
                key={m.mode}
                className={`hc-type-btn${mode === m.mode ? ' active' : ''}`}
                onClick={() => edit(setMode)(m.mode)}
              >
                {m.label}
              </button>
            ))}
          </div>

          {mode === 'missed_start' && (
            <div className="hc-field">
              <label htmlFor="cx-add-km">
                Distance missed at the start (km) — time is extrapolated from
                the first-km moving pace and the start moves earlier
              </label>
              <input
                id="cx-add-km"
                inputMode="decimal"
                value={addKm}
                onChange={(e) => edit(setAddKm)(e.target.value)}
              />
            </div>
          )}
          {mode === 'late_stop' && (
            <div className="hc-field">
              <label htmlFor="cx-trim">
                Minutes to trim from the end — removes that tail&apos;s
                distance, moving time and stream samples
              </label>
              <input
                id="cx-trim"
                inputMode="decimal"
                value={trimMin}
                onChange={(e) => edit(setTrimMin)(e.target.value)}
              />
            </div>
          )}
          {mode === 'totals' && (
            <div className="hc-row">
              <div className="hc-field">
                <label htmlFor="cx-km">Distance (km)</label>
                <input
                  id="cx-km"
                  inputMode="decimal"
                  value={totKm}
                  onChange={(e) => edit(setTotKm)(e.target.value)}
                />
              </div>
              <div className="hc-field">
                <label htmlFor="cx-time">Moving time</label>
                <input
                  id="cx-time"
                  value={totTime}
                  onChange={(e) => edit(setTotTime)(e.target.value)}
                />
              </div>
            </div>
          )}
          <div className="hc-field">
            <label htmlFor="cx-note">
              What happened (optional, kept with the correction)
            </label>
            <textarea
              id="cx-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {p && preview && (
            <table className="cx-preview">
              <thead>
                <tr>
                  <th />
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Distance</td>
                  <td>{p.before.distanceKm.toFixed(3)} km</td>
                  <td>{p.after.distanceKm.toFixed(3)} km</td>
                </tr>
                <tr>
                  <td>Moving time</td>
                  <td>{fmtDurationS(p.before.durationS)}</td>
                  <td>{fmtDurationS(p.after.durationS)}</td>
                </tr>
                <tr>
                  <td>{kind === 'run' ? 'Avg pace' : 'Avg speed'}</td>
                  <td>{fmtRate(kind, preview.rate.before)}</td>
                  <td>{fmtRate(kind, preview.rate.after)}</td>
                </tr>
                {p.after.startedAt !== p.before.startedAt && (
                  <tr>
                    <td>Start</td>
                    <td>{fmtStart(p.before.startedAt)}</td>
                    <td>{fmtStart(p.after.startedAt)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          {p && (
            <p className="muted small">
              {p.steps.map((s) => s.note).join(' ')}
            </p>
          )}

          {error && <p className="nt-error">{error}</p>}
          <div className="nt-field-row">
            <button
              className="nt-btn-ghost"
              disabled={busy}
              onClick={onPreview}
            >
              Preview
            </button>
            <button
              className="nt-btn"
              disabled={busy || !preview}
              onClick={onSave}
            >
              Save correction
            </button>
            <button
              className="nt-btn-ghost"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setPreview(null);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {!open && error && <p className="nt-error">{error}</p>}
    </section>
  );
}
