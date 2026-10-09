import { listDataPointsPage } from './client';
import type { WellnessDataPoint } from './types';
import type { StepsBucket } from '../../lib/fitbitCadence';

// Per-run granular Fitbit-wrist steps pull — mirrors heartRate.ts's shape for
// the HR stream. Feeds lib/fitbitCadence.ts's resampling to build an
// independent cadence-based second opinion on run-stop detection (see
// docs/methodology-log.md, 2026-09-05).
//
// Live-probed 2026-09-05: the `steps` dataType's List method DOES accept a
// fully-qualified `steps.interval.start_time` filter (mirrors the verified
// `heart_rate.sample_time.physical_time` grammar) at sub-run-window
// granularity — same INVALID_DATA_POINT_FILTER family as heart-rate, not the
// exercise dataType's unfilterable case. Within one run's window, THREE
// dataSource combos appear: `FITBIT/Google Fitbit Air` (the actual wrist
// device's own passively-measured 1-minute buckets — what we want),
// `FITBIT/MobileTrack` (Fitbit's own phone-accelerometer fallback tracker —
// same platform, NOT the wrist), and `HEALTH_CONNECT/PHONE` (the Samsung
// phone via Android Health Connect). Filtering to platform FITBIT and
// excluding the literal device name `MobileTrack` isolates the wrist band's
// own samples — the analog of dedupe.ts's platform-based origin filtering for
// exercise sessions, and of the daily-rollup double-counting problem
// wellnessMap.ts documents for the SAME steps dataType at the daily-total
// scale (overlapping multi-source samples) — here scoped to one run's window
// instead of a whole day, so the device filter alone is sufficient (no
// dailyRollUp-style aggregation needed).
//
// Native granularity is 1-MINUTE buckets, aligned to the wall-clock minute
// (e.g. 19:44:00–19:45:00Z) for the wrist device specifically — coarser than
// the ~2-3s HR sample rate. Coverage is NOT reliable: live-probed across 21
// real runs (2026-07-01 onward — the wrist device has NO steps data at all
// before that date in this account), wrist-bucket coverage was bimodal —
// most runs at 80-101% of expected buckets, several at under 15% (band
// likely off-wrist or desynced for that run) even though MobileTrack (phone
// fallback) had near-complete coverage throughout. See
// scripts/backfill-fitbit-cadence.ts for the per-run coverage gate this
// forces.

const MAX_PAGES = 10;
const WRIST_DEVICE_EXCLUDE = 'MobileTrack';

/** Whether a steps dataPoint's dataSource is the Fitbit Air wrist device itself (not its phone-fallback tracker). */
export function isWristStepsSource(dp: WellnessDataPoint): boolean {
  const platform = dp.dataSource?.platform?.toUpperCase();
  const deviceName = (dp.dataSource as { device?: { displayName?: string } } | undefined)?.device
    ?.displayName;
  return platform === 'FITBIT' && deviceName !== WRIST_DEVICE_EXCLUDE;
}

/**
 * Parse a page of `steps` dataPoints into sorted, deduped wrist-device
 * buckets (pure — unit-testable with no network). Points with an unparseable
 * interval or a non-finite step count are dropped. Duplicate exact start
 * times (shouldn't happen for one device's own recording, but tolerated) keep
 * the first occurrence.
 */
export function buildStepsBuckets(dataPoints: WellnessDataPoint[]): StepsBucket[] {
  const buckets: StepsBucket[] = [];
  const seenStarts = new Set<number>();
  for (const dp of dataPoints) {
    if (!isWristStepsSource(dp)) continue;
    const steps = (dp as { steps?: { interval?: { startTime?: string; endTime?: string }; count?: unknown } })
      .steps;
    const startTime = steps?.interval?.startTime;
    const endTime = steps?.interval?.endTime;
    if (!startTime || !endTime) continue;
    const startMs = Date.parse(startTime);
    const endMs = Date.parse(endTime);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    if (seenStarts.has(startMs)) continue;
    const rawCount = steps?.count;
    const count =
      typeof rawCount === 'number' ? rawCount : typeof rawCount === 'string' ? Number(rawCount) : NaN;
    if (!Number.isFinite(count) || count < 0) continue;
    seenStarts.add(startMs);
    buckets.push({ startMs, endMs, steps: count });
  }
  buckets.sort((a, b) => a.startMs - b.startMs);
  return buckets;
}

/**
 * Fetch + assemble the Fitbit wrist steps buckets for a run's [startMs, endMs]
 * window, paging through all results. Returns [] when the window has no
 * wrist-device steps data at all (device off-wrist, pre-dates the account's
 * Fitbit Air history, or a rate-limit/network issue the caller should treat
 * as "no data" rather than fail the whole backfill). A
 * GoogleHealthRateLimitError from the client propagates so the caller can
 * stop and resume later, same as fetchGoogleHealthHeartRateStream.
 */
export async function fetchWristStepsBuckets(
  accessToken: string,
  startMs: number,
  endMs: number,
): Promise<StepsBucket[]> {
  const startTime = new Date(startMs).toISOString();
  const endTime = new Date(endMs).toISOString();
  const filter =
    `steps.interval.start_time >= "${startTime}" AND ` + `steps.interval.start_time < "${endTime}"`;
  const all: WellnessDataPoint[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const page = await listDataPointsPage(accessToken, {
      dataType: 'steps',
      filter,
      pageSize: 500,
      pageToken,
    });
    all.push(...page.dataPoints);
    pageToken = page.nextPageToken;
    pages += 1;
  } while (pageToken && pages < MAX_PAGES);
  return buildStepsBuckets(all);
}
