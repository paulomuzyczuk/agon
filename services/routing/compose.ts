import type { RouteCandidate } from './types';
import { elevationGain } from './orsProvider';

// Compose a constrained route (CLAUDE.md #6 "pass through X / finish near Y")
// from two primitives the routing engine gives us separately:
//   • a SPINE — a point-to-point route home → …through… → near-finish. Honours the
//     waypoints but is whatever length it is (engines can't target a distance on
//     point-to-point routes).
//   • a PAD LOOP — a round_trip from the start sized to the leftover distance, so
//     the total hits the requested target.
// Stitching a pad loop (start→…→start) in front of the spine (start→…→finish)
// gives one continuous route: a warm-up loop from home, then out through the
// waypoints to the finish. Varying the pad loop's seed yields several different
// full routes that all honour the same constraints. Pure + unit-tested.

/** Minimum leftover distance worth padding with a loop (metres). Below this the
 *  spine already (nearly) meets the target, so we return the spine alone. */
export const MIN_PAD_M = 500;

/**
 * Stitch a pad loop in front of a spine into one candidate. The loop ends where
 * the spine begins (both at the start point), so we drop the spine's duplicated
 * first coordinate. Distance is additive; elevation is recomputed from the joined
 * 3-D geometry. The candidate's seed is the pad loop's seed (its shape variation).
 */
export function stitchLoopAndSpine(
  loop: RouteCandidate,
  spine: RouteCandidate,
): RouteCandidate {
  const coordinates = [...loop.coordinates, ...spine.coordinates.slice(1)];
  return {
    seed: loop.seed,
    distanceM: loop.distanceM + spine.distanceM,
    elevationGainM: elevationGain(undefined, coordinates),
    coordinates,
    provider: loop.provider,
  };
}

/** Turn a spine into a stand-alone candidate (used when it already meets target). */
export function spineAsCandidate(spine: RouteCandidate): RouteCandidate {
  return { ...spine, seed: 0 };
}
