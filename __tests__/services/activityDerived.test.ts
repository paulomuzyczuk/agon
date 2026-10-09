jest.mock('@/lib/athleteProfile', () => ({
  getAthleteProfile: () => ({
    hrRest: 60,
    hrMax: 190,
    ftpHistory: [{ watts: 250, date: '2026-01-01' }],
  }),
}));
jest.mock('@/services/logger', () => ({ logger: { warn: jest.fn() } }));
jest.mock('@/services/relativeEffort', () => ({
  recomputeRunRelativeEffort: jest.fn(),
}));
jest.mock('@/services/relativeEffortRides', () => ({
  recomputeRideRelativeEffort: jest.fn(),
}));
jest.mock('@/services/bestEfforts', () => ({
  recomputeRunBestEfforts: jest.fn(),
}));
jest.mock('@/services/ridePowerMetrics', () => ({
  recomputeRidePowerMetrics: jest.fn(),
}));
jest.mock('@/services/fuelingBalance', () => ({
  recomputeFuelingBalance: jest.fn(),
}));
jest.mock('@/services/trainingLoad', () => ({
  recomputeTrainingLoadFrom: jest.fn(),
}));
jest.mock('@/services/weather/enrich', () => ({
  refreshActivityWeather: jest.fn(),
}));

import { recomputeDerivedForActivity } from '@/services/activityDerived';
import { recomputeRidePowerMetrics } from '@/services/ridePowerMetrics';

// Step wiring for the power_metrics step (MZY-269), every recompute mocked.

const opts = { startMoved: false, fromDate: '2026-10-01' };
const powerMock = recomputeRidePowerMetrics as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('recomputeDerivedForActivity — power_metrics', () => {
  it('runs for a ride, with the profile FTP history, before training load', async () => {
    const result = await recomputeDerivedForActivity('ride', 'r1', opts);
    expect(powerMock).toHaveBeenCalledWith('r1', [
      { watts: 250, date: '2026-01-01' },
    ]);
    expect(result.failed).toEqual([]);
    expect(result.ok).toEqual([
      'relative_effort',
      'power_metrics',
      'fueling_balance',
      'training_load',
    ]);
  });

  it('never runs for a run', async () => {
    const result = await recomputeDerivedForActivity('run', 'x1', opts);
    expect(powerMock).not.toHaveBeenCalled();
    expect(result.ok).not.toContain('power_metrics');
  });

  it('reports a failure without throwing, and still runs the later steps', async () => {
    powerMock.mockRejectedValueOnce(new Error('boom'));
    const result = await recomputeDerivedForActivity('ride', 'r1', opts);
    expect(result.failed).toEqual(['power_metrics']);
    expect(result.ok).toContain('training_load');
  });
});
