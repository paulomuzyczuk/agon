import { FinishRunBodySchema } from '@/lib/liveRecordingRunBody';

// The finish (run) API boundary — HR samples may carry their strap (MZY-271).

const body = (sample: Record<string, unknown>) => ({
  recordingId: 'rec-1',
  startedAt: 1_000,
  endedAt: 2_000,
  deviceName: 'HRM 200',
  samples: [
    { tMs: 1_000, bpm: 120, sensorContact: 'supported-detected', ...sample },
  ],
  distanceKm: 5,
});

describe('FinishRunBodySchema', () => {
  it('accepts a sample without a device (older client)', () => {
    expect(FinishRunBodySchema.safeParse(body({})).success).toBe(true);
  });

  it('accepts a stamped sample', () => {
    const parsed = FinishRunBodySchema.parse(
      body({ deviceId: 'x', deviceName: 'HRM 200', deviceKind: 'heart_rate' }),
    );
    expect(parsed.samples[0]).toMatchObject({
      deviceId: 'x',
      deviceKind: 'heart_rate',
    });
  });

  it('rejects an empty device id', () => {
    expect(FinishRunBodySchema.safeParse(body({ deviceId: '' })).success).toBe(
      false,
    );
  });
});

describe('FinishRunBodySchema — GPS (MZY-282)', () => {
  const fix = {
    tMs: 1_200,
    lat: 52.4731234,
    lng: 13.4012345,
    altitudeM: 41.3,
    accuracyM: 4.7,
    speedMps: 3.12,
    deviceId: 'phone-gps',
    deviceName: 'Phone GPS',
    deviceKind: 'gps',
  };

  it('defaults gps to [] and lets distanceKm be omitted', () => {
    const { distanceKm: _omit, ...rest } = body({});
    const parsed = FinishRunBodySchema.parse(rest);
    expect(parsed.gps).toEqual([]);
    expect(parsed.distanceKm).toBeUndefined();
  });

  it('accepts a GPS-only run (no strap)', () => {
    const parsed = FinishRunBodySchema.parse({
      ...body({}),
      samples: [],
      gps: [fix, { ...fix, tMs: 2_100, altitudeM: null, speedMps: null }],
    });
    expect(parsed.gps).toHaveLength(2);
  });

  it('rejects a run with neither HR nor GPS', () => {
    expect(
      FinishRunBodySchema.safeParse({ ...body({}), samples: [], gps: [] })
        .success,
    ).toBe(false);
  });

  it('rejects an out-of-range coordinate', () => {
    expect(
      FinishRunBodySchema.safeParse({ ...body({}), gps: [{ ...fix, lat: 91 }] })
        .success,
    ).toBe(false);
  });
});
