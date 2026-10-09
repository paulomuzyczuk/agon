// GPS track maths for the live recorder (MZY-281/282). Pure — shared by the
// recorder (app/record/gpsLink.ts: which fixes to buffer, live distance/pace)
// and the flush (lib/liveRecordingStreams.ts: distance_m, distance_km), and
// unit-tested (__tests__/lib/gpsTrack.test.ts).
//
// Two filters, both chosen for a phone GPS on foot or on a bike:
//  1. ACCEPT (at write time, so the buffer holds the track that is stored):
//     drop a fix whose accuracy is worse than 30 m, a simulated one, one from
//     before the recording started or not newer than the last accepted fix,
//     and a jump implying > 30 m/s (108 km/h) from the last accepted fix.
//     After 3 jumps in a row the LAST ACCEPTED fix was the outlier, so the
//     track re-anchors on the new position instead of rejecting forever.
//  2. DISTANCE (jitter guard): a standing athlete's fixes wander a few metres
//     each second, which a plain haversine sum turns into phantom distance.
//     Distance only advances when the fix isn't reporting standing still
//     (its Doppler speed, when present, is >= 0.5 m/s) and it is at least
//     max(its accuracy, 5 m) from the last COUNTED fix — the anchor — and
//     then by the full anchor-to-fix distance, so a straight line keeps its
//     true length and a stop costs nothing once moving again.

import { haversineMeters } from './geo';

export const MAX_ACCURACY_M = 30;
export const MAX_SPEED_MPS = 30;
const JITTER_FLOOR_M = 5;
const JUMPS_BEFORE_REANCHOR = 3;
/** Below this the athlete is standing still: no distance added, no pace shown. */
const MIN_MOVING_SPEED_MPS = 0.5;

export interface TrackFix {
  tMs: number;
  lat: number;
  lng: number;
  accuracyM: number;
  speedMps?: number | null;
  simulated?: boolean;
}

export type RejectReason = 'inaccurate' | 'simulated' | 'stale' | 'jump';

export interface TrackStep {
  accepted: boolean;
  reason?: RejectReason;
  /** Distance so far over accepted fixes, after this one (m). */
  distanceM: number;
  /** Current speed (m/s): the fix's own, else the last segment's; null when unknown. */
  speedMps: number | null;
}

/** m/s between two fixes; Infinity when they share a timestamp. */
function segmentSpeedMps(a: TrackFix, b: TrackFix): number {
  const dt = (b.tMs - a.tMs) / 1000;
  const d = haversineMeters(a.lat, a.lng, b.lat, b.lng);
  return dt > 0 ? d / dt : Infinity;
}

/**
 * Cumulative distance along accepted fixes, with the jitter guard. A fix
 * that is > MAX_SPEED_MPS from the previous one can only be a re-anchor (the
 * accept filter rejects every other jump), so it moves the anchor and adds
 * nothing — which keeps the flush's recount identical to the live one.
 */
export function createDistanceCounter() {
  let anchor: TrackFix | null = null;
  let prev: TrackFix | null = null;
  let total = 0;
  return {
    /** Adds an accepted fix; returns the distance so far (m). */
    add(fix: TrackFix): number {
      const jumped = prev != null && segmentSpeedMps(prev, fix) > MAX_SPEED_MPS;
      prev = fix;
      if (!anchor || jumped) {
        anchor = fix;
        return total;
      }
      const standing =
        fix.speedMps != null && fix.speedMps < MIN_MOVING_SPEED_MPS;
      const d = haversineMeters(anchor.lat, anchor.lng, fix.lat, fix.lng);
      if (!standing && d >= Math.max(fix.accuracyM, JITTER_FLOOR_M)) {
        total += d;
        anchor = fix;
      }
      return total;
    },
    get distanceM() {
      return total;
    },
  };
}

/** Stateful filter + live stats for one recording's incoming fixes. */
export function createGpsTrack(startedAtMs: number) {
  const distance = createDistanceCounter();
  let last: TrackFix | null = null;
  let jumps = 0;

  function reject(reason: RejectReason): TrackStep {
    return {
      accepted: false,
      reason,
      distanceM: distance.distanceM,
      speedMps: null,
    };
  }

  return {
    push(fix: TrackFix): TrackStep {
      if (fix.simulated) return reject('simulated');
      if (!(fix.accuracyM <= MAX_ACCURACY_M)) return reject('inaccurate');
      if (fix.tMs < startedAtMs || (last && fix.tMs <= last.tMs))
        return reject('stale');

      let segmentSpeed: number | null = last
        ? segmentSpeedMps(last, fix)
        : null;
      if (segmentSpeed != null && segmentSpeed > MAX_SPEED_MPS) {
        jumps += 1;
        if (jumps < JUMPS_BEFORE_REANCHOR) return reject('jump');
        segmentSpeed = null; // re-anchor: the old position was the outlier
      }
      jumps = 0;
      last = fix;
      return {
        accepted: true,
        distanceM: distance.add(fix),
        speedMps: fix.speedMps ?? segmentSpeed,
      };
    },
  };
}

/** Cumulative distance (m) at each fix of an already-accepted track. */
export function cumulativeDistancesM(fixes: readonly TrackFix[]): number[] {
  const counter = createDistanceCounter();
  return fixes.map((f) => counter.add(f));
}

/** Pace in seconds per km, or null when (nearly) standing still. */
export function paceSecPerKm(speedMps: number | null): number | null {
  if (speedMps == null || speedMps < MIN_MOVING_SPEED_MPS) return null;
  return 1000 / speedMps;
}

/** "5:23" from seconds per km; "—" when there's no pace. */
export function formatPace(secPerKm: number | null): string {
  if (secPerKm == null || !Number.isFinite(secPerKm)) return '—';
  const total = Math.round(secPerKm);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
