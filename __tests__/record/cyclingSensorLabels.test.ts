import {
  cyclingSensorLabel,
  formatCyclingValue,
  type CyclingSensorState,
} from '@/app/record/useCyclingSensors';

// Pure display helpers of the recorder's cycling sensors (MZY-168 + power
// meter, MZY-270).

const sensor = (p: Partial<CyclingSensorState>): CyclingSensorState => ({
  id: 'x',
  deviceName: 'dev',
  role: 'speed',
  status: 'connected',
  value: null,
  pairedAt: 0,
  lastUpdatedAt: null,
  ...p,
});

describe('cyclingSensorLabel', () => {
  it('labels a power meter with watts and its crank cadence', () => {
    expect(
      cyclingSensorLabel(sensor({ role: 'power', value: 247, cadence: 88.6 })),
    ).toBe('Power meter — 247 W · 89 rpm');
  });

  it('keeps the CSC labels unchanged', () => {
    expect(cyclingSensorLabel(sensor({ role: 'speed', value: 27.46 }))).toBe(
      'Speed sensor — 27.5 km/h',
    );
    expect(
      cyclingSensorLabel(sensor({ role: 'cadence', status: 'disconnected' })),
    ).toBe('Cadence sensor — disconnected');
    expect(cyclingSensorLabel(sensor({ status: 'connecting' }))).toBe(
      'Identifying sensor…',
    );
  });
});

describe('formatCyclingValue', () => {
  const meter = sensor({ id: 'p', role: 'power', value: 250, cadence: 91.2 });

  it('shows live power', () => {
    expect(formatCyclingValue([meter], 'power', 0)).toBe('250');
  });

  it('falls back to the power meter for cadence when no cadence sensor is live', () => {
    expect(formatCyclingValue([meter], 'cadence', 0)).toBe('91');
  });

  it('prefers a dedicated cadence sensor over the power meter', () => {
    const csc = sensor({ id: 'c', role: 'cadence', value: 85 });
    expect(formatCyclingValue([meter, csc], 'cadence', 0)).toBe('85');
  });

  it('shows a dash with nothing connected', () => {
    expect(formatCyclingValue([], 'power', 0)).toBe('—');
    expect(
      formatCyclingValue([{ ...meter, status: 'disconnected' }], 'power', 0),
    ).toBe('—');
  });
});
