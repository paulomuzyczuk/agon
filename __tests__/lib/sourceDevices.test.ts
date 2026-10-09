import {
  buildDeviceIndex,
  deviceConflicts,
  formatSourceDevices,
  primaryDeviceFor,
  type LiveSource,
} from '@/lib/sourceDevices';

// MZY-271: which device's samples are recorded when several report the same
// metric, the alert listing them, and the stored per-point device index.

const src = (
  p: Partial<LiveSource> & Pick<LiveSource, 'id' | 'role'>,
): LiveSource => ({
  name: p.id,
  connected: true,
  pairedAt: 0,
  ...p,
});

describe('primaryDeviceFor', () => {
  it('records the only device when there is one', () => {
    expect(
      primaryDeviceFor('watts', [src({ id: 'pedals', role: 'power' })]),
    ).toBe('pedals');
  });

  it('records the earliest-paired of two power meters', () => {
    const sources = [
      src({ id: 'trainer', role: 'power', pairedAt: 200 }),
      src({ id: 'pedals', role: 'power', pairedAt: 100 }),
    ];
    expect(primaryDeviceFor('watts', sources)).toBe('pedals');
  });

  it('switches over when the primary disconnects', () => {
    const sources = [
      src({ id: 'pedals', role: 'power', pairedAt: 100, connected: false }),
      src({ id: 'trainer', role: 'power', pairedAt: 200 }),
    ];
    expect(primaryDeviceFor('watts', sources)).toBe('trainer');
  });

  it('prefers a cadence sensor over a power meter, whatever the pairing order', () => {
    const sources = [
      src({ id: 'pedals', role: 'power', pairedAt: 1, reportsCadence: true }),
      src({ id: 'csc', role: 'cadence', pairedAt: 999 }),
    ];
    expect(primaryDeviceFor('cadence', sources)).toBe('csc');
    expect(primaryDeviceFor('watts', sources)).toBe('pedals');
  });

  it('uses the power meter for cadence once it reports crank data and no sensor is live', () => {
    const meter = src({ id: 'pedals', role: 'power' });
    expect(primaryDeviceFor('cadence', [meter])).toBeNull();
    expect(
      primaryDeviceFor('cadence', [{ ...meter, reportsCadence: true }]),
    ).toBe('pedals');
  });

  it('ignores a CSC sensor whose role is not known yet', () => {
    expect(
      primaryDeviceFor('velocity', [src({ id: 'x', role: 'identifying' })]),
    ).toBeNull();
  });
});

describe('deviceConflicts', () => {
  it('is empty with one device per metric', () => {
    expect(
      deviceConflicts([
        src({ id: 'strap', role: 'heart_rate' }),
        src({ id: 'speed', role: 'speed' }),
        src({ id: 'pedals', role: 'power' }),
      ]),
    ).toEqual([]);
  });

  it('names the recorded and ignored devices for each doubled metric', () => {
    const sources = [
      src({
        id: 'a',
        name: 'Assioma Duo',
        role: 'power',
        pairedAt: 1,
        reportsCadence: true,
      }),
      src({ id: 'k', name: 'KICKR CORE', role: 'power', pairedAt: 2 }),
      src({ id: 'c', name: 'Cadence Sensor 2', role: 'cadence', pairedAt: 3 }),
    ];
    expect(deviceConflicts(sources)).toEqual([
      {
        metric: 'cadence',
        label: 'Cadence',
        recorded: 'Cadence Sensor 2',
        ignored: ['Assioma Duo'],
      },
      {
        metric: 'watts',
        label: 'Power',
        recorded: 'Assioma Duo',
        ignored: ['KICKR CORE'],
      },
    ]);
  });

  it('drops a disconnected device from the alert', () => {
    expect(
      deviceConflicts([
        src({ id: 'a', role: 'power', pairedAt: 1 }),
        src({ id: 'b', role: 'power', pairedAt: 2, connected: false }),
      ]),
    ).toEqual([]);
  });
});

describe('buildDeviceIndex', () => {
  it('lists devices in order of first use and maps ids to indices', () => {
    const { sourceDevices, indexOf } = buildDeviceIndex([
      { tMs: 30, deviceId: 'p', deviceName: 'Pedals', deviceKind: 'power' },
      { tMs: 10, deviceId: 'h', deviceName: 'Strap', deviceKind: 'heart_rate' },
      { tMs: 20, deviceId: 'h', deviceName: 'Strap', deviceKind: 'heart_rate' },
      { tMs: 40 }, // a pre-MZY-271 sample: no device
    ]);
    expect(sourceDevices).toEqual([
      { name: 'Strap', kind: 'heart_rate', ble_id: 'h' },
      { name: 'Pedals', kind: 'power', ble_id: 'p' },
    ]);
    expect(indexOf('h')).toBe(0);
    expect(indexOf('p')).toBe(1);
    expect(indexOf(undefined)).toBeNull();
    expect(indexOf('nope')).toBeNull();
  });
});

describe('formatSourceDevices', () => {
  it('formats the device list, or null when unknown', () => {
    expect(
      formatSourceDevices([
        { name: 'Garmin HRM 200', kind: 'heart_rate', ble_id: 'x' },
        { name: 'Assioma Duo', kind: 'power', ble_id: 'y' },
      ]),
    ).toBe('Garmin HRM 200 (HR) · Assioma Duo (power)');
    expect(
      formatSourceDevices([
        { name: 'Garmin HRM 200', kind: 'heart_rate', ble_id: 'x' },
        { name: 'Phone GPS', kind: 'gps', ble_id: 'phone-gps' },
      ]),
    ).toBe('Garmin HRM 200 (HR) · Phone GPS (GPS)');
    expect(formatSourceDevices(null)).toBeNull();
    expect(formatSourceDevices([])).toBeNull();
  });
});
