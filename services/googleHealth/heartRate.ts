import { listHeartRateSamplesPage } from './client';
import type { HeartRateSample } from './types';
import type { RunStreamData } from '../runStreams';

// Attach a run's granular Fitbit wrist HR from Google Health's `heart-rate`
// measurement dataType (verified live 2026-07-24: ~1 sample every 2–3 s). This is
// kept SEPARATE from the SOT run metrics: the series lands in run_streams under
// source 'fitbit', and avg/max only FILL a run's HR when the SOT record had none
// (COALESCE in services/runs.ts) — so a chest-strap avg from the SOT is never
// overwritten by wrist HR.

// A year of per-run HR is far under this; the cap is a runaway backstop.
const MAX_PAGES = 20;

export interface HeartRateStream {
  stream: RunStreamData; // index-aligned (timeS, heartrate) for run_streams
  avgHr: number;
  maxHr: number;
}

/**
 * Build an index-aligned HR stream from raw samples (pure — unit-testable with no
 * network). Samples may arrive in any order (the API returns newest-first); they
 * are sorted ascending and rebased so timeS[0] = 0. Returns null when there are no
 * usable samples.
 */
export function buildHeartRateStream(
  samples: HeartRateSample[],
): HeartRateStream | null {
  const pts: Array<{ t: number; bpm: number }> = [];
  for (const s of samples) {
    const t = Date.parse(s.heartRate.sampleTime.physicalTime);
    const bpm = s.heartRate.beatsPerMinute;
    if (Number.isFinite(t) && Number.isFinite(bpm) && bpm > 0) {
      pts.push({ t, bpm: Math.round(bpm) });
    }
  }
  if (pts.length === 0) return null;
  pts.sort((a, b) => a.t - b.t);
  const t0 = pts[0]!.t;
  const stream: RunStreamData = {
    timeS: pts.map((p) => Math.round((p.t - t0) / 1000)),
    heartrate: pts.map((p) => p.bpm),
  };
  const avgHr = Math.round(pts.reduce((a, p) => a + p.bpm, 0) / pts.length);
  const maxHr = pts.reduce((m, p) => Math.max(m, p.bpm), 0);
  return { stream, avgHr, maxHr };
}

/**
 * Fetch + assemble the Fitbit HR stream for a run's [startMs, endMs] window,
 * paging through all samples. Returns null when the window has no HR. A
 * GoogleHealthRateLimitError from the client propagates so the sync can stop and
 * resume later.
 */
export async function fetchGoogleHealthHeartRateStream(
  accessToken: string,
  startMs: number,
  endMs: number,
): Promise<HeartRateStream | null> {
  const startTime = new Date(startMs).toISOString();
  const endTime = new Date(endMs).toISOString();
  const all: HeartRateSample[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const page = await listHeartRateSamplesPage(accessToken, {
      startTime,
      endTime,
      pageToken,
      pageSize: 1000,
    });
    all.push(...page.dataPoints);
    pageToken = page.nextPageToken;
    pages += 1;
  } while (pageToken && pages < MAX_PAGES);
  return buildHeartRateStream(all);
}
