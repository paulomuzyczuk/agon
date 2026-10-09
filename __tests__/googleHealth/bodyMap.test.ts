import {
  mapBodyPoint,
  dedupeMirroredBodyPoints,
  backfillGoogleHealthWellness,
  type GoogleHealthWellnessDeps,
} from '@/services/googleHealth/wellness';
import type {
  WellnessDataPoint,
  WellnessDataPointList,
} from '@/services/googleHealth/types';
import type { SourcedBodyMetricRecord } from '@/services/bodyMetrics';

// Body-composition pass (MZY-216). `weight` payloads below are copied from the
// shape the real Google Health API returned 2026-09-25 (sampleTime with
// physicalTime + civilTime.date; weightGrams). `body-fat` is TODO(live).

function weightPoint(
  id: string,
  physicalTime: string,
  civil: { year: number; month: number; day: number },
  weightGrams: number,
): WellnessDataPoint {
  return {
    name: `users/1234567890123456789/dataTypes/weight/dataPoints/${id}`,
    dataSource: { recordingMethod: 'MANUAL', platform: 'FITBIT' },
    weight: {
      sampleTime: {
        physicalTime,
        utcOffset: '7200s',
        civilTime: { date: civil },
      },
      weightGrams,
    },
  } as unknown as WellnessDataPoint;
}

describe('mapBodyPoint', () => {
  it('maps a live-shaped weight point to kg on its civil (local) day', () => {
    const dp = weightPoint(
      '1000000000000000001',
      '2026-09-22T07:23:15.515Z',
      { year: 2026, month: 9, day: 22 },
      75500,
    );
    expect(mapBodyPoint(dp, 'weight')?.record).toEqual({
      date: '2026-09-22',
      source: 'google_health',
      externalId: 'weight:1000000000000000001',
      weightKg: 75.5,
      bodyFatPct: null,
    });
  });

  it('falls back to the athlete-local day of physicalTime without civilTime', () => {
    const dp = {
      name: 'users/me/dataTypes/weight/dataPoints/w1',
      // 23:30Z on Sep 21 is 01:30 on Sep 22 in Europe/Berlin (CEST).
      weight: {
        sampleTime: { physicalTime: '2026-09-21T23:30:00Z' },
        weightGrams: '75150',
      },
    } as unknown as WellnessDataPoint;
    expect(mapBodyPoint(dp, 'weight')?.record).toMatchObject({
      date: '2026-09-22',
      weightKg: 75.15,
    });
  });

  it('maps body-fat from a percentage field', () => {
    const dp = {
      name: 'users/me/dataTypes/body-fat/dataPoints/b1',
      bodyFat: {
        sampleTime: { civilTime: { date: { year: 2026, month: 9, day: 22 } } },
        percentage: 21.26,
      },
    } as unknown as WellnessDataPoint;
    expect(mapBodyPoint(dp, 'body-fat')?.record).toMatchObject({
      date: '2026-09-22',
      externalId: 'body-fat:b1',
      weightKg: null,
      bodyFatPct: 21.3,
    });
  });

  it('returns null without an id, a day, or a plausible value', () => {
    const noId = {
      weight: { weightGrams: 75000 },
    } as unknown as WellnessDataPoint;
    expect(mapBodyPoint(noId, 'weight')).toBeNull();
    const noDay = {
      name: 'users/me/dataTypes/weight/dataPoints/x',
      weight: { weightGrams: 75000 },
    } as unknown as WellnessDataPoint;
    expect(mapBodyPoint(noDay, 'weight')).toBeNull();
    const zero = weightPoint(
      'z',
      '2026-09-22T07:00:00Z',
      { year: 2026, month: 9, day: 22 },
      0,
    );
    expect(mapBodyPoint(zero, 'weight')).toBeNull();
  });
});

describe('dedupeMirroredBodyPoints', () => {
  it('collapses Health Connect mirrors (same day + value), keeping the earliest', () => {
    const civil = { year: 2026, month: 4, day: 20 };
    const later = mapBodyPoint(
      weightPoint('a', '2026-04-20T12:43:03Z', civil, 78000),
      'weight',
    )!;
    const earlier = mapBodyPoint(
      weightPoint('b', '2026-04-20T10:43:03Z', civil, 78000),
      'weight',
    )!;
    const other = mapBodyPoint(
      weightPoint('c', '2026-04-20T18:00:00Z', civil, 77400),
      'weight',
    )!;
    const out = dedupeMirroredBodyPoints([later, earlier, other]);
    expect(out.map((r) => r.externalId)).toEqual(['weight:b', 'weight:c']);
  });
});

describe('backfillGoogleHealthWellness body pass', () => {
  function makeDeps(): {
    deps: GoogleHealthWellnessDeps;
    bodies: SourcedBodyMetricRecord[];
  } {
    const bodies: SourcedBodyMetricRecord[] = [];
    const deps: GoogleHealthWellnessDeps = {
      getAccessToken: async () => 'tok',
      listDataPoints: async (_t, params): Promise<WellnessDataPointList> => {
        if (params.dataType !== 'weight') return { dataPoints: [] };
        expect(params.filter).toBeUndefined();
        return {
          dataPoints: [
            weightPoint(
              'old',
              '2026-07-01T15:36:08Z',
              { year: 2026, month: 7, day: 1 },
              74000,
            ),
            weightPoint(
              'new',
              '2026-09-22T07:23:15Z',
              { year: 2026, month: 9, day: 22 },
              75500,
            ),
          ],
        };
      },
      dailyRollUp: async () => ({ rollupDataPoints: [] }),
      upsertDailyActivity: async () => {},
      upsertSleepSession: async () => {},
      upsertHrvDaily: async () => {},
      upsertBodyMetric: async (r) => {
        bodies.push(r);
      },
    };
    return { deps, bodies };
  }

  it('upserts only weigh-ins inside the requested local-day window', async () => {
    const { deps, bodies } = makeDeps();
    const summary = await backfillGoogleHealthWellness(
      {
        since: '2026-09-01',
        until: '2026-09-25',
        activity: false,
        sleep: false,
        hrv: false,
        pageDelayMs: 0,
      },
      deps,
    );
    expect(summary.bodyUpserted).toBe(1);
    expect(bodies).toEqual([
      expect.objectContaining({ date: '2026-09-22', weightKg: 75.5 }),
    ]);
  });

  it('is skipped when body: false', async () => {
    const { deps, bodies } = makeDeps();
    const summary = await backfillGoogleHealthWellness(
      {
        since: '2026-01-01',
        activity: false,
        sleep: false,
        hrv: false,
        body: false,
        pageDelayMs: 0,
      },
      deps,
    );
    expect(summary.bodyUpserted).toBe(0);
    expect(bodies).toHaveLength(0);
  });
});
