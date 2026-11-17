import { renderToStaticMarkup } from 'react-dom/server';
import { LiveSummary } from '@/app/record/LiveSummary';
import type { GpsState } from '@/app/record/gpsLink';

const START = 1_800_000_000_000;

function html(
  gps: GpsState,
  nowS: number,
  activityType: 'run' | 'ride' = 'run',
): string {
  return renderToStaticMarkup(
    <LiveSummary
      activityType={activityType}
      startedAt={START}
      nowMs={START + nowS * 1000}
      gps={gps}
    />,
  );
}

type GpsFixState = Extract<GpsState, { distanceM: number }>;

const ok = (over: Partial<GpsFixState>): GpsState => ({
  kind: 'ok',
  accuracyM: 4,
  distanceM: 0,
  speedMps: 3,
  fixTMs: START,
  kmCrossingsS: [],
  ...over,
});

describe('LiveSummary', () => {
  it('run, third km underway: time, avg pace, this-km pace, splits', () => {
    // km 1 in 5:00, km 2 in 4:50, then 500 m of km 3 at 5:20/km.
    const out = html(
      ok({
        distanceM: 2500,
        fixTMs: START + 750_000,
        kmCrossingsS: [300, 590],
      }),
      751,
    );
    expect(out).toContain('12:31'); // elapsed
    expect(out).toContain('5:00'); // avg pace: 750 s / 2.5 km
    expect(out).toContain('5:20'); // (750 − 590) s over 500 m, per km
    expect(out).toContain('km 3 · 500 m');
    expect(out).toMatch(/live-split-km">1<\/span> 5:00/);
    expect(out).toMatch(/live-split-km">2<\/span> 4:50/);
  });

  it('shows dashes, not nonsense, in the first metres', () => {
    const out = html(ok({ distanceM: 8, fixTMs: START + 4000 }), 5);
    expect(out).toContain('0:05');
    expect(out).toContain('—');
    expect(out).not.toContain('Infinity');
    expect(out).not.toContain('NaN');
    expect(out).not.toContain('live-splits');
  });

  it('browser (no GPS): just the clock', () => {
    const out = html({ kind: 'unsupported' }, 65);
    expect(out).toContain('1:05');
    expect(out).not.toContain('min/km');
  });

  it('ride: time, km and average speed instead of pace', () => {
    const out = html(
      ok({ distanceM: 10_000, fixTMs: START + 1200_000 }),
      1200,
      'ride',
    );
    expect(out).toContain('20:00');
    expect(out).toContain('10.00');
    expect(out).toContain('30.0'); // 10 km in 20 min
    expect(out).not.toContain('min/km');
  });
});
