'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import type { RunDetail } from '@/lib/marts';
import { RunRoute } from '@/components/RunRoute';
import { RunStreamChart } from '@/components/RunStreamChart';
import {
  ActivityCorrectionPanel,
  CorrectedBadge,
} from '@/components/ActivityCorrectionPanel';
import { StopSuggestionCard } from '@/components/StopSuggestionCard';
import { fmtDuration, fmtPace } from '@/components/RunsList';

// Run-detail view: full run_streams (GPS route as inline SVG, HR-over-distance
// chart) plus the run's logged fields. Degrades gracefully for route-less or
// stream-less runs (most Fitbit-only runs have HR but no GPS track — CLAUDE.md).

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: RunDetail };

export default function RunDetailPage() {
  const params = useParams<{ id: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });
  // Bumped after a correction is saved/reverted → refetch the detail.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    fetch(`/api/runs/${params.id}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<RunDetail>;
      })
      .then((data) => live && setState({ kind: 'ready', data }))
      .catch(
        (err) => live && setState({ kind: 'error', message: err.message ?? 'failed' }),
      );
    return () => {
      live = false;
    };
  }, [params.id, version]);

  return (
    <main className="page">
      <header className="page-head">
        <Link href="/runs" className="back">
          ← Runs
        </Link>
        <h1>
          {state.kind === 'ready' ? state.data.date : 'Run'}{' '}
          {state.kind === 'ready' &&
            state.data.correction.correctedFields.length > 0 && <CorrectedBadge />}
        </h1>
      </header>

      {state.kind === 'loading' && <p className="muted">Loading…</p>}
      {state.kind === 'error' && (
        <p className="muted">Couldn’t load this run ({state.message}).</p>
      )}

      {state.kind === 'ready' && (
        <RunDetailBody run={state.data} onChanged={() => setVersion((v) => v + 1)} />
      )}
    </main>
  );
}

function RunDetailBody({ run, onChanged }: { run: RunDetail; onChanged: () => void }) {
  return (
    <>
      <section className="card">
        <div className="run-detail-grid">
          <Field label="Distance" value={run.distanceKm != null ? `${run.distanceKm.toFixed(2)} km` : null} />
          <Field label="Duration" value={fmtDuration(run.durationS)} />
          <Field label="Avg pace" value={fmtPace(run.avgPaceSPerKm)} />
          <Field label="Avg / max HR" value={
            run.avgHr != null ? `${run.avgHr} / ${run.maxHr ?? '—'} bpm` : null
          } />
          <Field label="Elevation gain" value={run.elevationGainM != null ? `${run.elevationGainM.toFixed(0)} m` : null} />
          <Field label="Moving time" value={
            run.movingTimeS != null
              ? `${fmtDuration(run.movingTimeS)}${run.pausedTimeS ? ` (${Math.round(run.pausedTimeS)}s stopped)` : ''}${movingFlagTag(run.movingFlagSource)}`
              : null
          } />
          <Field label="Est. net time" value={
            run.estimatedNetTimeS != null
              ? `${fmtDuration(run.estimatedNetTimeS)}${
                  run.netTimeStopsCounted
                    ? ` (${run.netTimeStopsCounted} stop${run.netTimeStopsCounted === 1 ? '' : 's'})`
                    : ''
                }${movingFlagTag(run.movingFlagSource)}`
              : null
          } />
          <Field label="Est. net pace" value={fmtPace(run.estimatedNetPaceSPerKm)} />
          <Field label="Relative Effort" value={
            run.relativeEffort != null
              ? `${run.relativeEffort.toFixed(0)}${run.relativeEffortMethod ? ` (${run.relativeEffortMethod})` : ''}`
              : null
          } />
          <Field label="Weather" value={
            run.tempC != null
              ? `${run.tempC.toFixed(0)}°C${run.weatherConditions ? `, ${run.weatherConditions}` : ''}`
              : null
          } />
          <Field label="Shoe" value={run.shoeUsed} />
          <Field label="Perceived effort" value={run.perceivedEffort != null ? `${run.perceivedEffort}/10` : null} />
          <Field label="Source" value={run.source} />
        </div>
        {run.painLocation && (
          <p className="muted small" style={{ marginTop: '0.6rem' }}>
            Pain: {run.painLocation}
            {run.painOnsetKm != null ? ` from ${run.painOnsetKm.toFixed(1)} km` : ''}
          </p>
        )}
        {run.generalNotes && (
          <p className="small" style={{ marginTop: '0.5rem', whiteSpace: 'pre-line' }}>
            {run.generalNotes}
          </p>
        )}
      </section>

      {run.stopSuggestion && (
        <StopSuggestionCard kind="run" suggestion={run.stopSuggestion} onChanged={onChanged} />
      )}

      <ActivityCorrectionPanel
        key={`${run.distanceKm}-${run.durationS}-${run.correction.startedAt}`}
        kind="run"
        id={run.id}
        correction={run.correction}
        distanceKm={run.distanceKm}
        durationS={run.durationS}
        onChanged={onChanged}
      />

      <section className="card" style={{ marginTop: '1rem' }}>
        <h2 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>Route</h2>
        {run.stream ? (
          <RunRoute lat={run.stream.lat} lng={run.stream.lng} />
        ) : (
          <p className="muted small">No stream data for this run.</p>
        )}
      </section>

      <section className="card" style={{ marginTop: '1rem' }}>
        <h2 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>Heart rate</h2>
        {run.stream ? (
          <RunStreamChart
            heartrate={run.stream.heartrate}
            distanceM={run.stream.distanceM}
            timeS={run.stream.timeS}
          />
        ) : (
          <p className="muted small">No stream data for this run.</p>
        )}
        {run.stream && (
          <p className="muted small" style={{ marginTop: '0.4rem' }}>
            Stream source: {run.stream.source}
          </p>
        )}
        {run.sensors && (
          <p className="muted small" style={{ marginTop: '0.2rem' }}>
            Sensors: {run.sensors}
          </p>
        )}
      </section>
    </>
  );
}

/** " · derived" tag when the run's stop detection came from Agon's in-house heuristic, not Strava's real flag. */
function movingFlagTag(source: 'strava' | 'derived' | null): string {
  return source === 'derived' ? ' · derived' : '';
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="run-detail-field">
      <span className="label">{label}</span>
      <span className="value">{value ?? '—'}</span>
    </div>
  );
}
