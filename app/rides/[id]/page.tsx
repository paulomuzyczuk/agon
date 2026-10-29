'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import type { RideDetail, RidePower } from '@/lib/rideMarts';
import { formatPowerMetricsField, formatRidePowerField } from '@/lib/ridePower';
import { RunRoute } from '@/components/RunRoute';
import { RunStreamChart } from '@/components/RunStreamChart';
import { PowerCurveChart } from '@/components/PowerCurveChart';
import { PowerZones } from '@/components/PowerZones';
import {
  ActivityCorrectionPanel,
  CorrectedBadge,
} from '@/components/ActivityCorrectionPanel';
import { StopSuggestionCard } from '@/components/StopSuggestionCard';
import { fmtDuration } from '@/components/RunsList';
import { fmtSpeed } from '@/components/RidesList';

// Ride-detail view: full ride_streams (GPS route, HR-over-distance chart)
// plus the ride's logged fields, and — only for a power-meter ride — NP/IF/
// TSS and the power curve (MZY-269). Mirrors app/runs/[id]/page.tsx. Reuses
// RunRoute/RunStreamChart directly — both are generic over lat/lng/
// heartrate/distanceM/timeS with no run-specific coupling, so a duplicate
// RideRoute/RideStreamChart would be pure copy-paste.

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: RideDetail };

export default function RideDetailPage() {
  const params = useParams<{ id: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });
  // Bumped after a correction is saved/reverted → refetch the detail.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    fetch(`/api/rides/${params.id}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<RideDetail>;
      })
      .then((data) => live && setState({ kind: 'ready', data }))
      .catch(
        (err) =>
          live && setState({ kind: 'error', message: err.message ?? 'failed' }),
      );
    return () => {
      live = false;
    };
  }, [params.id, version]);

  return (
    <main className="page">
      <header className="page-head">
        <Link href="/rides" className="back">
          ← Rides
        </Link>
        <h1>
          {state.kind === 'ready' ? state.data.date : 'Ride'}{' '}
          {state.kind === 'ready' &&
            state.data.correction.correctedFields.length > 0 && (
              <CorrectedBadge />
            )}
        </h1>
      </header>

      {state.kind === 'loading' && <p className="muted">Loading…</p>}
      {state.kind === 'error' && (
        <p className="muted">Couldn’t load this ride ({state.message}).</p>
      )}

      {state.kind === 'ready' && (
        <RideDetailBody
          ride={state.data}
          onChanged={() => setVersion((v) => v + 1)}
        />
      )}
    </main>
  );
}

function RideDetailBody({
  ride,
  onChanged,
}: {
  ride: RideDetail;
  onChanged: () => void;
}) {
  return (
    <>
      <section className="card">
        <div className="run-detail-grid">
          <Field
            label="Distance"
            value={
              ride.distanceKm != null
                ? `${ride.distanceKm.toFixed(2)} km`
                : null
            }
          />
          <Field label="Duration" value={fmtDuration(ride.durationS)} />
          <Field
            label="Avg / max speed"
            value={
              ride.avgSpeedKmh != null
                ? `${fmtSpeed(ride.avgSpeedKmh)}${ride.maxSpeedKmh != null ? ` / ${fmtSpeed(ride.maxSpeedKmh)}` : ''}`
                : null
            }
          />
          <Field
            label="Avg / max HR"
            value={
              ride.avgHr != null
                ? `${ride.avgHr} / ${ride.maxHr ?? '—'} bpm`
                : null
            }
          />
          {ride.power && <PowerField power={ride.power} />}
          {ride.measuredPower && (
            <Field {...formatPowerMetricsField(ride.measuredPower)} />
          )}
          <Field
            label="Elevation gain"
            value={
              ride.elevationGainM != null
                ? `${ride.elevationGainM.toFixed(0)} m`
                : null
            }
          />
          <Field
            label="Weather"
            value={
              ride.tempC != null
                ? `${ride.tempC.toFixed(0)}°C${ride.weatherConditions ? `, ${ride.weatherConditions}` : ''}`
                : null
            }
          />
          <Field label="Bike" value={ride.bikeUsed} />
          <Field
            label="Perceived effort"
            value={
              ride.perceivedEffort != null ? `${ride.perceivedEffort}/10` : null
            }
          />
          <Field
            label="Relative Effort"
            value={
              ride.relativeEffort != null
                ? `${ride.relativeEffort.toFixed(0)}${ride.relativeEffortMethod ? ` (${ride.relativeEffortMethod})` : ''}`
                : null
            }
          />
          <Field label="Source" value={ride.source} />
        </div>
        {ride.generalNotes && (
          <p
            className="small"
            style={{ marginTop: '0.5rem', whiteSpace: 'pre-line' }}
          >
            {ride.generalNotes}
          </p>
        )}
      </section>

      {ride.stopSuggestion && (
        <StopSuggestionCard
          kind="ride"
          suggestion={ride.stopSuggestion}
          onChanged={onChanged}
        />
      )}

      <ActivityCorrectionPanel
        key={`${ride.distanceKm}-${ride.durationS}-${ride.correction.startedAt}`}
        kind="ride"
        id={ride.id}
        correction={ride.correction}
        distanceKm={ride.distanceKm}
        durationS={ride.durationS}
        onChanged={onChanged}
      />

      <section className="card" style={{ marginTop: '1rem' }}>
        <h2 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>Route</h2>
        {ride.stream ? (
          <RunRoute lat={ride.stream.lat} lng={ride.stream.lng} />
        ) : (
          <p className="muted small">No stream data for this ride.</p>
        )}
      </section>

      {ride.measuredPower?.zones && (
        <section className="card" style={{ marginTop: '1rem' }}>
          <h2 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>
            Time in power zones
          </h2>
          <PowerZones zones={ride.measuredPower.zones} />
          <p className="muted small" style={{ marginTop: '0.4rem' }}>
            Coggan zones from your FTP of {ride.measuredPower.ftpW} W, measured
            by a power meter. Coasting counts as zone 1.
          </p>
        </section>
      )}

      {ride.measuredPower && (
        <section className="card" style={{ marginTop: '1rem' }}>
          <h2 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>
            Power curve
          </h2>
          <PowerCurveChart curve={ride.measuredPower.curve} />
          <p className="muted small" style={{ marginTop: '0.4rem' }}>
            Best average power per duration, measured by a power meter (
            {ride.measuredPower.streamSource}).
          </p>
        </section>
      )}

      <section className="card" style={{ marginTop: '1rem' }}>
        <h2 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>
          Heart rate
        </h2>
        {ride.stream ? (
          <RunStreamChart
            heartrate={ride.stream.heartrate}
            distanceM={ride.stream.distanceM}
            timeS={ride.stream.timeS}
          />
        ) : (
          <p className="muted small">No stream data for this ride.</p>
        )}
        {ride.stream && (
          <p className="muted small" style={{ marginTop: '0.4rem' }}>
            Stream source: {ride.stream.source}
          </p>
        )}
        {ride.sensors && (
          <p className="muted small" style={{ marginTop: '0.2rem' }}>
            Sensors: {ride.sensors}
          </p>
        )}
      </section>
    </>
  );
}

/** Rendered only when the ride has power; the label carries its provenance. */
function PowerField({ power }: { power: RidePower }) {
  const field = formatRidePowerField(power);
  return field ? <Field label={field.label} value={field.value} /> : null;
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="run-detail-field">
      <span className="label">{label}</span>
      <span className="value">{value ?? '—'}</span>
    </div>
  );
}
