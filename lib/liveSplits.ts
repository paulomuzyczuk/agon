// Live per-km statistics for the record page: elapsed time, average pace, the
// pace inside the km being run, and the finished km splits. Pure — the GPS link
// feeds it every accepted fix (app/record/gpsLink.ts) and the page turns the
// result into tiles (app/record/LiveSummary.tsx); unit-tested in
// __tests__/lib/liveSplits.test.ts.
//
// Time basis: elapsed = wall clock since Start, stops included (the distance
// counter doesn't advance while standing, so a stop lengthens the pace, as on
// a stopwatch). Km boundaries are placed by linear interpolation between the
// two fixes that straddle them, so a split isn't rounded to the fix interval.

const KM = 1000;

/** Below this much distance into a km the pace is noise (one GPS step). */
export const MIN_KM_PROGRESS_M = 50;
/** Below this much total distance the average pace is noise. */
export const MIN_AVG_DISTANCE_M = 50;

export interface SplitTracker {
  /** Feeds an accepted fix: cumulative distance (m) at epoch-ms `tMs`. */
  add(tMs: number, distanceM: number): void;
  /** Seconds since Start at which each whole km was completed, in order. */
  crossingsS(): number[];
}

export function createSplitTracker(startedAtMs: number): SplitTracker {
  const crossings: number[] = [];
  let prev: { tMs: number; distanceM: number } | null = null;

  return {
    add(tMs, distanceM) {
      const from = prev ?? { tMs: startedAtMs, distanceM: 0 };
      if (distanceM > from.distanceM) {
        for (
          let boundary = (crossings.length + 1) * KM;
          boundary <= distanceM;
          boundary += KM
        ) {
          const share =
            (boundary - from.distanceM) / (distanceM - from.distanceM);
          const at = from.tMs + share * (tMs - from.tMs);
          crossings.push((at - startedAtMs) / 1000);
        }
      }
      prev = { tMs, distanceM };
    },
    crossingsS: () => [...crossings],
  };
}

export interface LiveSummaryInput {
  startedAtMs: number;
  nowMs: number;
  /** Cumulative distance (m) at the latest accepted fix. */
  distanceM: number;
  /** Epoch ms of that fix. */
  fixTMs: number;
  crossingsS: readonly number[];
}

export interface LiveSummary {
  elapsedS: number;
  distanceM: number;
  /** Elapsed ÷ distance for the whole activity; null while it is just starting. */
  avgPaceSecPerKm: number | null;
  /** Average pace inside the km being run; null in its first metres. */
  currentKmPaceSecPerKm: number | null;
  /** Metres run inside the current km (0–999). */
  currentKmProgressM: number;
  /** Duration (s) of each finished km, oldest first. */
  splitsS: number[];
}

export function summarizeLive(input: LiveSummaryInput): LiveSummary {
  const { startedAtMs, nowMs, distanceM, fixTMs, crossingsS } = input;
  const elapsedS = Math.max(0, (nowMs - startedAtMs) / 1000);

  const splitsS = crossingsS.map(
    (t, i) => t - (i > 0 ? crossingsS[i - 1]! : 0),
  );
  const kmStartDistanceM = crossingsS.length * KM;
  const kmStartS = crossingsS.at(-1) ?? 0;
  const currentKmProgressM = Math.max(0, distanceM - kmStartDistanceM);
  const fixElapsedS = (fixTMs - startedAtMs) / 1000;

  return {
    elapsedS,
    distanceM,
    avgPaceSecPerKm:
      distanceM >= MIN_AVG_DISTANCE_M ? fixElapsedS / (distanceM / KM) : null,
    currentKmPaceSecPerKm:
      currentKmProgressM >= MIN_KM_PROGRESS_M
        ? (fixElapsedS - kmStartS) / (currentKmProgressM / KM)
        : null,
    currentKmProgressM,
    splitsS,
  };
}

/** "1:05:09" from seconds at an hour or more, otherwise "5:09". */
export function formatDuration(totalS: number): string {
  const s = Math.max(0, Math.floor(totalS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
