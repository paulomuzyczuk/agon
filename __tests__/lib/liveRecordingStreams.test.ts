import {
  toRunStreamData,
  computeHrSummary,
  computeSpeedSummary,
  toRideStreamData,
  computePowerSummary,
} from '@/lib/liveRecordingStreams';

describe('toRunStreamData', () => {
  it('converts absolute epoch ms to time_s relative to the recording start', () => {
    const startedAtMs = 1_000_000;
    const samples = [
      { tMs: 1_000_000, bpm: 120 },
      { tMs: 1_002_000, bpm: 124 },
      { tMs: 1_005_400, bpm: 130 },
    ];
    expect(toRunStreamData(samples, startedAtMs)).toEqual({
      timeS: [0, 2, 5],
      heartrate: [120, 124, 130],
    });
  });

  it('returns an empty axis and no series for no samples', () => {
    expect(toRunStreamData([], 0)).toEqual({ timeS: [] });
  });
});

describe('computeHrSummary', () => {
  it('computes avg (rounded) and max bpm', () => {
    const samples = [{ bpm: 120 }, { bpm: 130 }, { bpm: 125 }];
    expect(computeHrSummary(samples)).toEqual({ avgHr: 125, maxHr: 130 });
  });

  it('returns nulls, not zero, for an empty recording', () => {
    expect(computeHrSummary([])).toEqual({ avgHr: null, maxHr: null });
  });

  it('rounds the average to the nearest integer', () => {
    const samples = [{ bpm: 120 }, { bpm: 121 }];
    expect(computeHrSummary(samples)).toEqual({ avgHr: 121, maxHr: 121 });
  });
});

describe('computeSpeedSummary', () => {
  it('computes avg (2dp) and max km/h', () => {
    const samples = [{ speedKmh: 20 }, { speedKmh: 30 }, { speedKmh: 25 }];
    expect(computeSpeedSummary(samples)).toEqual({
      avgSpeedKmh: 25,
      maxSpeedKmh: 30,
    });
  });

  it('returns nulls, not zero, for an empty ride', () => {
    expect(computeSpeedSummary([])).toEqual({
      avgSpeedKmh: null,
      maxSpeedKmh: null,
    });
  });
});

describe('toRideStreamData', () => {
  const startedAtMs = 1_000_000;

  it('merges HR, speed, and cadence samples onto one bucketed second axis', () => {
    const samples = {
      hr: [
        { tMs: 1_000_000, bpm: 120 },
        { tMs: 1_002_000, bpm: 125 },
      ],
      speed: [
        { tMs: 1_000_000, speedKmh: 21.6 },
        { tMs: 1_001_000, speedKmh: 25.2 },
      ],
      cadence: [{ tMs: 1_001_000, rpm: 80 }],
    };
    expect(toRideStreamData(samples, startedAtMs)).toEqual({
      timeS: [0, 1, 2],
      heartrate: [120, null, 125],
      cadence: [null, 80, null],
      velocitySmoothMps: [6, 7, null],
    });
  });

  it('rounds fractional cadence to whole rpm (ride_streams.cadence is INTEGER[])', () => {
    const result = toRideStreamData(
      {
        hr: [],
        speed: [],
        cadence: [
          { tMs: 1_000_000, rpm: 1.1503679155198563 },
          { tMs: 1_001_000, rpm: 87.6 },
        ],
      },
      startedAtMs,
    );
    expect(result.cadence).toEqual([1, 88]);
  });

  it('omits a metric entirely when its sensor was never connected', () => {
    const samples = {
      hr: [{ tMs: 1_000_000, bpm: 120 }],
      speed: [],
      cadence: [],
    };
    const result = toRideStreamData(samples, startedAtMs);
    expect(result.heartrate).toEqual([120]);
    expect(result.cadence).toBeUndefined();
    expect(result.velocitySmoothMps).toBeUndefined();
  });

  it('returns an empty timeS axis when no sensor ever reported', () => {
    expect(
      toRideStreamData({ hr: [], speed: [], cadence: [] }, startedAtMs),
    ).toEqual({
      timeS: [],
      heartrate: undefined,
      cadence: undefined,
      velocitySmoothMps: undefined,
    });
  });
});

describe('toRideStreamData — power meter (MZY-270)', () => {
  const startedAtMs = 1_000_000;

  it('emits watts labelled device, aligned with the other sensors', () => {
    const result = toRideStreamData(
      {
        hr: [{ tMs: 1_000_000, bpm: 120 }],
        speed: [],
        cadence: [],
        power: [
          { tMs: 1_000_000, watts: 210 },
          { tMs: 1_001_020, watts: 230 },
        ],
      },
      startedAtMs,
    );
    expect(result.timeS).toEqual([0, 1]);
    expect(result.heartrate).toEqual([120, null]);
    expect(result.watts).toEqual([210, 230]);
    expect(result.wattsSource).toBe('device');
  });

  it('has no watts (and no source) without power samples', () => {
    const result = toRideStreamData(
      { hr: [{ tMs: 1_000_000, bpm: 120 }], speed: [], cadence: [], power: [] },
      startedAtMs,
    );
    expect(result).not.toHaveProperty('watts');
    expect(result).not.toHaveProperty('wattsSource');
  });
});

describe('computePowerSummary', () => {
  const at = (sec: number, watts: number) => ({
    tMs: 5_000_000 + sec * 1000,
    watts,
  });

  it('is all-null with no samples', () => {
    expect(computePowerSummary([])).toEqual({
      avgPowerW: null,
      maxPowerW: null,
      kilojoules: null,
    });
  });

  it('averages over seconds, holds short gaps, and sums work in kJ', () => {
    // 200 W for 2 s (a 2 s gap is held), then 300 W for 1 s → 700 J.
    expect(computePowerSummary([at(0, 200), at(2, 300)])).toEqual({
      avgPowerW: 233,
      maxPowerW: 300,
      kilojoules: 0.7,
    });
  });

  it('excludes a long stop instead of counting it as time', () => {
    const riding = Array.from({ length: 600 }, (_, i) => at(i, 250));
    const afterStop = Array.from({ length: 600 }, (_, i) => at(1800 + i, 250));
    expect(computePowerSummary([...riding, ...afterStop])).toEqual({
      avgPowerW: 250,
      maxPowerW: 250,
      kilojoules: 300, // 250 W × 1200 active s
    });
  });

  it('does not double-count a 4 Hz meter', () => {
    const fourHz = Array.from({ length: 40 }, (_, i) => ({
      tMs: 5_000_000 + i * 250,
      watts: 200,
    }));
    expect(computePowerSummary(fourHz).kilojoules).toBe(2); // 10 s × 200 W
  });
});

describe('per-point source devices (MZY-271)', () => {
  const t0 = 1_000_000;
  const strap = {
    deviceId: 'h1',
    deviceName: 'HRM 200',
    deviceKind: 'heart_rate' as const,
  };
  const pedals = {
    deviceId: 'p1',
    deviceName: 'Assioma',
    deviceKind: 'power' as const,
  };
  const trainer = {
    deviceId: 'p2',
    deviceName: 'KICKR',
    deviceKind: 'power' as const,
  };

  it('aligns a device index with every ride series, NULL where no value', () => {
    const result = toRideStreamData(
      {
        hr: [
          { tMs: t0, bpm: 120, ...strap },
          { tMs: t0 + 2000, bpm: 122, ...strap },
        ],
        speed: [],
        cadence: [],
        power: [
          { tMs: t0 + 1000, watts: 200, ...pedals },
          // primary pedals dropped out → the trainer took over (a switchover)
          { tMs: t0 + 2000, watts: 210, ...trainer },
        ],
      },
      t0,
    );
    expect(result.timeS).toEqual([0, 1, 2]);
    expect(result.sourceDevices).toEqual([
      { name: 'HRM 200', kind: 'heart_rate', ble_id: 'h1' },
      { name: 'Assioma', kind: 'power', ble_id: 'p1' },
      { name: 'KICKR', kind: 'power', ble_id: 'p2' },
    ]);
    expect(result.heartrateSourceDevice).toEqual([0, null, 0]);
    expect(result.wattsSourceDevice).toEqual([null, 1, 2]);
    expect(result.cadenceSourceDevice).toBeUndefined();
  });

  it('adds no device fields for samples buffered before device stamps existed', () => {
    const result = toRideStreamData(
      { hr: [{ tMs: t0, bpm: 120 }], speed: [], cadence: [] },
      t0,
    );
    expect(result).not.toHaveProperty('sourceDevices');
    expect(result).not.toHaveProperty('heartrateSourceDevice');
  });

  it('stamps a run HR series, including a strap swap mid-run', () => {
    const other = {
      deviceId: 'h2',
      deviceName: 'Polar H9',
      deviceKind: 'heart_rate' as const,
    };
    const result = toRunStreamData(
      [
        { tMs: t0, bpm: 120, ...strap },
        { tMs: t0 + 1000, bpm: 121, ...other },
      ],
      t0,
    );
    expect(result.sourceDevices?.map((d) => d.name)).toEqual([
      'HRM 200',
      'Polar H9',
    ]);
    expect(result.heartrateSourceDevice).toEqual([0, 1]);
  });
});
