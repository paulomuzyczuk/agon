// Pure half of `pnpm sync:all` (MZY-420): which steps run, how a run of them is
// judged, and when a failure is worth a Telegram message. No I/O, unit-tested.

export interface SyncStep {
  /** Short label for logs and the alert. */
  name: string;
  /** Arguments after `pnpm`. */
  args: string[];
}

export interface StepResult {
  name: string;
  ok: boolean;
  code: number;
  /** Last lines of output, kept so an alert can say why. */
  tail: string;
}

/** How far back the wellness pass re-reads each run; passes are idempotent. */
export const WELLNESS_LOOKBACK_DAYS = 7;

/** The steps, in order. Strava outranks Google Health, so order only matters for logs. */
export function syncSteps(todayISO: string): SyncStep[] {
  const since = new Date(
    Date.parse(`${todayISO}T00:00:00Z`) - WELLNESS_LOOKBACK_DAYS * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  return [
    { name: 'gh:sync', args: ['gh:sync'] },
    { name: 'gh:wellness', args: ['gh:wellness', `--since=${since}`] },
    { name: 'strava:sync', args: ['strava:sync'] },
    { name: 'strava:sync-rides', args: ['strava:sync-rides'] },
  ];
}

/**
 * Run every step, whatever happens to the others: one expired token must not
 * stop the remaining sources from syncing.
 */
export async function runAll(
  steps: SyncStep[],
  run: (step: SyncStep) => Promise<{ code: number; tail: string }>,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) {
    try {
      const { code, tail } = await run(step);
      results.push({ name: step.name, ok: code === 0, code, tail });
    } catch (err) {
      results.push({
        name: step.name,
        ok: false,
        code: -1,
        tail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

export interface AlertState {
  /** The failing step names, sorted and joined, when the last alert was sent. */
  signature: string;
  sentAt: number;
}

/**
 * Re-alert about an unchanged failure at most this often. Just under a day, so
 * a daily timer (with a few minutes of jitter) still re-alerts each day while a
 * timer that runs more often does not repeat itself.
 */
export const ALERT_COOLDOWN_MS = 20 * 60 * 60 * 1000;

/**
 * Alert when something fails that was not already reported, or when the same
 * failure is still there after the cooldown. An expired token must be one
 * message a day, not one per run. All green clears the state, so the next
 * failure alerts immediately.
 */
export function decideAlert(
  results: StepResult[],
  state: AlertState | null,
  now: number,
): { alert: boolean; next: AlertState | null } {
  const failed = results
    .filter((r) => !r.ok)
    .map((r) => r.name)
    .sort();
  if (failed.length === 0) return { alert: false, next: null };
  const signature = failed.join(',');
  const fresh =
    state === null ||
    state.signature !== signature ||
    now - state.sentAt >= ALERT_COOLDOWN_MS;
  return fresh
    ? { alert: true, next: { signature, sentAt: now } }
    : { alert: false, next: state };
}

export function formatAlert(results: StepResult[]): string {
  const failed = results.filter((r) => !r.ok);
  const lines = failed.map(
    (r) => `• ${r.name} (exit ${r.code})${r.tail ? `: ${r.tail}` : ''}`,
  );
  const ok = results.length - failed.length;
  return (
    `⚠️ Agon sync: ${failed.length} of ${results.length} steps failed ` +
    `(${ok} ok).\n${lines.join('\n')}\n` +
    'Details: journalctl --user -u agon-sync -n 50'
  );
}

/** Keep an alert short enough for Telegram and free of long output. */
export function lastLines(text: string, n = 2, maxChars = 200): string {
  const out = text.trim().split('\n').slice(-n).join(' ').trim();
  return out.length > maxChars ? `${out.slice(0, maxChars - 1)}…` : out;
}
