// A live recording's distance_km without a hand-typed value (MZY-282). Pure —
// the Save list previews it (app/record/UnflushedRecordings.tsx) and the flush
// decides with it (services/liveRecording*.ts); unit-tested in
// __tests__/lib/liveRecordingDistance.test.ts.
//
// Precedence (athlete's decision): a typed distance always wins; then the
// phone-GPS track; then, for a ride, the speed sensor's wheel-revolution
// odometer — e.g. indoors, or recorded in the browser, which has no GPS.

import { cumulativeDistancesM, type TrackFix } from './gpsTrack';

export type DistanceSource = 'manual' | 'gps' | 'wheel';

export interface ResolvedDistance {
  km: number;
  source: DistanceSource;
}

const UINT32 = 2 ** 32;

/** runs/rides.distance_km is NUMERIC(7,3) CHECK > 0. */
const toKm = (m: number) => Math.round(m) / 1000;

/** Distance along an accepted GPS track (m), counted as live (lib/gpsTrack.ts). */
export function gpsDistanceM(fixes: readonly TrackFix[]): number {
  return cumulativeDistancesM(fixes).at(-1) ?? 0;
}

/**
 * Wheel distance (m) from the CSC speed sensor's cumulative uint32
 * revolution counter: last − first per device (rollover-safe), summed.
 * Counting carries on through a BLE drop — the sensor keeps counting — so a
 * reconnect loses nothing. Samples without `wheelRevs` (buffered before
 * MZY-282) are ignored.
 */
export function wheelDistanceM(
  speed: ReadonlyArray<{ tMs: number; wheelRevs?: number; deviceId?: string }>,
  circumferenceMm: number,
): number {
  const span = new Map<string, { first: number; last: number }>();
  for (const s of [...speed].sort((a, b) => a.tMs - b.tMs)) {
    if (s.wheelRevs == null) continue;
    const key = s.deviceId ?? '';
    const cur = span.get(key);
    span.set(key, { first: cur?.first ?? s.wheelRevs, last: s.wheelRevs });
  }
  let revs = 0;
  for (const { first, last } of span.values()) {
    revs += (last - first + UINT32) % UINT32;
  }
  return (revs * circumferenceMm) / 1000;
}

export function resolveDistanceKm(input: {
  manualKm?: number | null;
  gpsM?: number;
  wheelM?: number;
}): ResolvedDistance | null {
  if (input.manualKm != null && input.manualKm > 0) {
    return { km: input.manualKm, source: 'manual' };
  }
  const candidates: Array<[DistanceSource, number | undefined]> = [
    ['gps', input.gpsM],
    ['wheel', input.wheelM],
  ];
  for (const [source, m] of candidates) {
    if (m != null && toKm(m) > 0) return { km: toKm(m), source };
  }
  return null;
}
