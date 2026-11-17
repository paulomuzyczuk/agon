import { formatPace } from '@/lib/gpsTrack';
import { formatDuration, summarizeLive } from '@/lib/liveSplits';
import type { ActivityType } from '@/lib/liveRecordingDb';
import type { GpsState } from './gpsLink';

// The "glance while running" panel (shown only while recording): elapsed time,
// average pace, the pace inside the km being run and the finished km splits.
// All the maths is lib/liveSplits.ts; this only lays it out. Needs the phone
// GPS (Android app) for anything distance-based; in the browser it still
// shows the clock.

interface Props {
  activityType: ActivityType;
  startedAt: number;
  nowMs: number;
  gps: GpsState;
}

export function LiveSummary({ activityType, startedAt, nowMs, gps }: Props) {
  const hasGps = gps.kind === 'ok' || gps.kind === 'weak';
  const s = summarizeLive({
    startedAtMs: startedAt,
    nowMs,
    distanceM: hasGps ? gps.distanceM : 0,
    fixTMs: hasGps ? gps.fixTMs : startedAt,
    crossingsS: hasGps ? gps.kmCrossingsS : [],
  });
  const time = <Tile value={formatDuration(s.elapsedS)} label="time" />;

  if (!hasGps) {
    return <div className="stat-row live-summary">{time}</div>;
  }

  if (activityType === 'ride') {
    const kmh =
      s.elapsedS > 0 && s.distanceM >= 50
        ? ((s.distanceM / s.elapsedS) * 3.6).toFixed(1)
        : '—';
    return (
      <div className="stat-row live-summary">
        {time}
        <Tile value={(s.distanceM / 1000).toFixed(2)} label="km" />
        <Tile value={kmh} label="avg km/h" />
      </div>
    );
  }

  const kmNumber = s.splitsS.length + 1;
  return (
    <>
      <div className="stat-row live-summary">
        {time}
        <Tile value={formatPace(s.avgPaceSecPerKm)} label="avg min/km" />
        <Tile
          value={formatPace(s.currentKmPaceSecPerKm)}
          label={`km ${kmNumber} · ${Math.round(s.currentKmProgressM)} m`}
        />
      </div>
      {s.splitsS.length > 0 && (
        <ol className="live-splits" aria-label="Finished kilometres">
          {s.splitsS.map((sec, i) => (
            <li key={i}>
              <span className="live-split-km">{i + 1}</span> {formatPace(sec)}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function Tile({ value, label }: { value: string; label: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
