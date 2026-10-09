import { FinishRideBodySchema } from '@/lib/liveRecordingRideBody';

// The finish-ride API boundary (MZY-270 adds power-meter samples).

const base = {
  recordingId: 'rec-1',
  startedAt: 1_000,
  endedAt: 2_000,
  samples: { hr: [{ tMs: 1_000, bpm: 120 }], speed: [], cadence: [] },
  distanceKm: 12.3,
};

describe('FinishRideBodySchema — power', () => {
  it('accepts a body with no power key (older client) and defaults it to []', () => {
    const parsed = FinishRideBodySchema.parse(base);
    expect(parsed.samples.power).toEqual([]);
  });

  it('accepts device power samples', () => {
    const parsed = FinishRideBodySchema.parse({
      ...base,
      samples: { ...base.samples, power: [{ tMs: 1_500, watts: 245 }] },
    });
    expect(parsed.samples.power).toEqual([{ tMs: 1_500, watts: 245 }]);
  });

  it.each([-1, 3001, 12.5])(
    'rejects an implausible watts value (%p)',
    (watts) => {
      expect(
        FinishRideBodySchema.safeParse({
          ...base,
          samples: { ...base.samples, power: [{ tMs: 1_500, watts }] },
        }).success,
      ).toBe(false);
    },
  );
});

describe('per-sample device stamps (MZY-271)', () => {
  it('accepts stamped and unstamped samples side by side', () => {
    const parsed = FinishRideBodySchema.parse({
      ...base,
      samples: {
        ...base.samples,
        power: [
          {
            tMs: 1_500,
            watts: 245,
            deviceId: 'abc',
            deviceName: 'Assioma',
            deviceKind: 'power',
          },
          { tMs: 1_600, watts: 250 },
        ],
      },
    });
    expect(parsed.samples.power[0]).toMatchObject({
      deviceId: 'abc',
      deviceKind: 'power',
    });
    expect(parsed.samples.power[1]).not.toHaveProperty('deviceId');
  });

  it('rejects an unknown device kind', () => {
    expect(
      FinishRideBodySchema.safeParse({
        ...base,
        samples: {
          ...base.samples,
          hr: [{ tMs: 1_000, bpm: 120, deviceKind: 'wifi' }],
        },
      }).success,
    ).toBe(false);
  });

  it("accepts the phone GPS's device kind (MZY-281)", () => {
    expect(
      FinishRideBodySchema.safeParse({
        ...base,
        samples: {
          ...base.samples,
          hr: [
            { tMs: 1_000, bpm: 120, deviceId: 'phone-gps', deviceKind: 'gps' },
          ],
        },
      }).success,
    ).toBe(true);
  });
});

describe('FinishRideBodySchema — GPS + wheel distance (MZY-282)', () => {
  it('defaults gps to [] and lets distanceKm be omitted', () => {
    const { distanceKm: _omit, ...rest } = base;
    const parsed = FinishRideBodySchema.parse(rest);
    expect(parsed.samples.gps).toEqual([]);
    expect(parsed.distanceKm).toBeUndefined();
  });

  it('accepts wheelRevs on speed samples and a GPS track', () => {
    const parsed = FinishRideBodySchema.parse({
      ...base,
      samples: {
        ...base.samples,
        speed: [{ tMs: 1_100, speedKmh: 27.43, wheelRevs: 4_000_123 }],
        gps: [
          {
            tMs: 1_270,
            lat: 52.4731234,
            lng: 13.4012345,
            altitudeM: null,
            accuracyM: 4.2,
            speedMps: 7.62,
          },
        ],
      },
    });
    expect(parsed.samples.speed[0]!.wheelRevs).toBe(4_000_123);
    expect(parsed.samples.gps).toHaveLength(1);
  });

  it('rejects a fractional wheel counter', () => {
    expect(
      FinishRideBodySchema.safeParse({
        ...base,
        samples: {
          ...base.samples,
          speed: [{ tMs: 1_100, speedKmh: 27, wheelRevs: 12.5 }],
        },
      }).success,
    ).toBe(false);
  });
});
