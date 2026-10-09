jest.mock('@/services/db', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
}));

import {
  pickDeviceStream,
  scoreRidePower,
  type DeviceWattsStream,
} from '@/services/ridePowerMetrics';

// Pure selection + scoring over synthetic DEVICE streams (MZY-269). The
// device-only gate itself is a SQL WHERE clause — covered by the integration
// lane (__tests__/integration/ridePowerMetrics.test.ts).

const stream = (
  source: string,
  watts: Array<number | null>,
  date = '2026-10-04',
): DeviceWattsStream => ({
  rideId: 'ride-1',
  date,
  source,
  timeS: watts.map((_, i) => i),
  watts,
});

describe('pickDeviceStream', () => {
  it('prefers the stream with the most non-null watts', () => {
    const sparse = stream('strava', [200, null, null, null]);
    const dense = stream('live_recording', [200, 210, 220, null]);
    expect(pickDeviceStream([sparse, dense])).toBe(dense);
  });

  it('keeps the first on a tie', () => {
    const a = stream('a', [200, 200]);
    const b = stream('b', [300, 300]);
    expect(pickDeviceStream([a, b])).toBe(a);
  });

  it('is null when no stream has any watts', () => {
    expect(pickDeviceStream([])).toBeNull();
    expect(pickDeviceStream([stream('a', [null, null])])).toBeNull();
  });
});

describe('scoreRidePower', () => {
  const hour = Array.from({ length: 3600 }, () => 250);
  const history = [
    { watts: 200, date: '2026-01-01' },
    { watts: 250, date: '2026-09-01' },
  ];

  it('anchors IF/TSS on the FTP in force on the ride date', () => {
    const late = scoreRidePower([stream('s', hour, '2026-10-04')], history);
    expect(late).toMatchObject({
      rideId: 'ride-1',
      streamSource: 's',
      npW: 250,
      ftpW: 250,
      intensityFactor: 1,
      tss: 100,
    });
    const early = scoreRidePower([stream('s', hour, '2026-05-01')], history);
    expect(early).toMatchObject({ ftpW: 200, intensityFactor: 1.25 });
  });

  it('computes NP without IF/TSS when no FTP applies yet', () => {
    const row = scoreRidePower([stream('s', hour, '2025-12-01')], history);
    expect(row).toMatchObject({ npW: 250, ftpW: null, tss: null });
  });

  it('is null with no stream or a stream too short for NP', () => {
    expect(scoreRidePower([], history)).toBeNull();
    expect(scoreRidePower([stream('s', [300, 300, 300])], history)).toBeNull();
  });
});
