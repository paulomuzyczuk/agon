import {
  syncSteps,
  runAll,
  decideAlert,
  formatAlert,
  lastLines,
  ALERT_COOLDOWN_MS,
  type StepResult,
} from '@/lib/syncAll';

// `pnpm sync:all` (MZY-420): a failing source must not stop the others, and a
// failure that keeps happening must be one Telegram message, not eight a day.

const ok = (name: string): StepResult => ({
  name,
  ok: true,
  code: 0,
  tail: '',
});
const bad = (name: string, tail = 'boom'): StepResult => ({
  name,
  ok: false,
  code: 1,
  tail,
});

describe('syncSteps', () => {
  it('pulls Google Health then Strava, then recomputes the derived metrics', () => {
    expect(syncSteps('2026-10-29').map((s) => s.name)).toEqual([
      'gh:sync',
      'gh:wellness',
      'strava:sync',
      'strava:sync-rides',
      're:backfill',
      're:backfill-rides',
      'be:backfill',
      'fueling:backfill',
      'tl:backfill',
      'rp:backfill',
    ]);
  });

  it('writes the derived steps (the backfills are a dry run without --write)', () => {
    const derived = syncSteps('2026-10-29').filter(
      (s) => s.name.endsWith(':backfill') || s.name === 're:backfill-rides',
    );
    expect(derived).toHaveLength(6);
    for (const s of derived) expect(s.args).toContain('--write');
  });

  it('computes training load after both Relative Effort scores, and predictions after best efforts', () => {
    const names = syncSteps('2026-10-29').map((s) => s.name);
    const at = (n: string) => names.indexOf(n);
    expect(at('tl:backfill')).toBeGreaterThan(at('re:backfill'));
    expect(at('tl:backfill')).toBeGreaterThan(at('re:backfill-rides'));
    expect(at('rp:backfill')).toBeGreaterThan(at('be:backfill'));
  });

  it('derives after ingest, so new rows are included', () => {
    const names = syncSteps('2026-10-29').map((s) => s.name);
    expect(names.indexOf('re:backfill')).toBeGreaterThan(
      names.indexOf('strava:sync-rides'),
    );
  });

  it('gives the wellness pass a rolling 7-day window (it requires --since)', () => {
    const wellness = syncSteps('2026-10-29').find(
      (s) => s.name === 'gh:wellness',
    );
    expect(wellness!.args).toEqual(['gh:wellness', '--since=2026-10-22']);
  });

  it('crosses a month boundary correctly', () => {
    const wellness = syncSteps('2026-11-03').find(
      (s) => s.name === 'gh:wellness',
    );
    expect(wellness!.args[1]).toBe('--since=2026-10-27');
  });
});

describe('runAll', () => {
  const steps = syncSteps('2026-10-29');

  it('keeps going after a failing step and reports each one', async () => {
    const seen: string[] = [];
    const results = await runAll(steps, async (s) => {
      seen.push(s.name);
      return s.name === 'gh:sync'
        ? { code: 1, tail: 'token expired' }
        : { code: 0, tail: '' };
    });
    expect(seen).toEqual(steps.map((s) => s.name));
    expect(results.map((r) => r.ok)).toEqual([
      false,
      ...steps.slice(1).map(() => true),
    ]);
    expect(results[0]).toMatchObject({ code: 1, tail: 'token expired' });
  });

  it('turns a thrown error (e.g. pnpm not found) into a failed step', async () => {
    const results = await runAll(steps.slice(0, 2), async (s) => {
      if (s.name === 'gh:sync') throw new Error('spawn pnpm ENOENT');
      return { code: 0, tail: '' };
    });
    expect(results[0]).toMatchObject({
      ok: false,
      code: -1,
      tail: 'spawn pnpm ENOENT',
    });
    expect(results[1]!.ok).toBe(true);
  });
});

describe('decideAlert', () => {
  const NOW = 1_800_000_000_000;

  it('is silent and clears state when everything passed', () => {
    expect(
      decideAlert([ok('a'), ok('b')], { signature: 'a', sentAt: NOW - 1 }, NOW),
    ).toEqual({ alert: false, next: null });
  });

  it('alerts on the first failure', () => {
    const r = decideAlert([ok('a'), bad('b')], null, NOW);
    expect(r).toEqual({ alert: true, next: { signature: 'b', sentAt: NOW } });
  });

  it('does not repeat the same failure within a day', () => {
    const state = { signature: 'b', sentAt: NOW - 3 * 3600_000 };
    expect(decideAlert([ok('a'), bad('b')], state, NOW)).toEqual({
      alert: false,
      next: state,
    });
  });

  it('repeats a persistent failure after the cooldown', () => {
    const state = { signature: 'b', sentAt: NOW - ALERT_COOLDOWN_MS };
    expect(decideAlert([bad('b')], state, NOW).alert).toBe(true);
  });

  it('alerts again when a different step starts failing', () => {
    const state = { signature: 'b', sentAt: NOW - 1000 };
    const r = decideAlert([bad('b'), bad('a')], state, NOW);
    expect(r).toEqual({ alert: true, next: { signature: 'a,b', sentAt: NOW } });
  });

  it('a failure after a clean run alerts at once, even right after the last alert', () => {
    const afterGreen = decideAlert(
      [ok('a')],
      { signature: 'a', sentAt: NOW - 1 },
      NOW,
    );
    expect(decideAlert([bad('a')], afterGreen.next, NOW + 1).alert).toBe(true);
  });
});

describe('formatAlert / lastLines', () => {
  it('names each failed step and how many passed', () => {
    const text = formatAlert([ok('a'), bad('b', 'token expired')]);
    expect(text).toContain('1 of 2 steps failed (1 ok)');
    expect(text).toContain('• b (exit 1): token expired');
    expect(text).not.toContain('• a');
  });

  it('keeps only the last lines and caps their length', () => {
    expect(lastLines('one\ntwo\nthree\nfour')).toBe('three four');
    expect(lastLines('x'.repeat(500))).toHaveLength(200);
    expect(lastLines('  \n ')).toBe('');
  });
});
