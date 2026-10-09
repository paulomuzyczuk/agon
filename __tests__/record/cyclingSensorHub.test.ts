import {
  createCyclingSensorHub,
  type CyclingSensorState,
} from '@/app/record/cyclingSensorHub';
import { createFakeBleTransport, flush, stateCell } from './fakeBleTransport';

// The recorder's cycling sensors over a fake BleTransport (MZY-275): pairing,
// role detection, device-stamped samples, link drops and the MZY-271
// primary-device hand-over.

const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const wheel = (revs: number, t1024: number) => [
  0x01,
  ...le16(revs),
  0,
  0,
  ...le16(t1024),
];
const crank = (revs: number, t1024: number) => [
  0x02,
  ...le16(revs),
  ...le16(t1024),
];
const power = (watts: number, revs: number, t1024: number) => [
  0x20,
  0x00,
  ...le16(watts),
  ...le16(revs),
  ...le16(t1024),
];

const SPEED = { id: 'speed-1', name: 'Speed Sensor 2' };
const CAD = { id: 'cad-1', name: 'Cadence Sensor 2' };
const CAD2 = { id: 'cad-2', name: 'Spare cadence' };
const PM = { id: 'pm-1', name: 'Assioma' };

function setup() {
  const transport = createFakeBleTransport();
  const sensors = stateCell<CyclingSensorState[]>([]);
  const written = {
    speed: [] as Array<{
      deviceId?: string;
      speedKmh: number;
      wheelRevs?: number;
    }>,
    cadence: [] as Array<{ deviceId?: string; rpm: number }>,
    power: [] as Array<{ deviceId?: string; watts: number }>,
  };
  const errors: string[] = [];
  let recordingId: string | null = null;
  let t = 1_000;
  const hub = createCyclingSensorHub({
    transport,
    setSensors: sensors.set,
    getRecordingId: () => recordingId,
    onError: (m) => errors.push(m),
    append: {
      speed: async (s) => void written.speed.push(s),
      cadence: async (s) => void written.cadence.push(s),
      power: async (s) => void written.power.push(s),
    },
    now: () => (t += 1000),
  });
  async function pair(
    device: { id: string; name: string },
    kind: 'csc' | 'power' = 'csc',
  ) {
    transport.nextPick(device);
    hub.connect(kind);
    await flush();
  }
  const sensor = (id: string) => sensors.get().find((s) => s.id === id);
  return {
    transport,
    hub,
    written,
    errors,
    pair,
    sensor,
    record: (id: string | null) => (recordingId = id),
  };
}

describe('cyclingSensorHub', () => {
  it('pairs a sensor over the transport and marks it connected', async () => {
    const { transport, pair, sensor } = setup();
    await pair(SPEED);
    expect(transport.requested).toEqual(['csc']);
    expect(transport.connected(SPEED.id)).toBe(true);
    expect(sensor(SPEED.id)).toMatchObject({
      status: 'connected',
      role: 'identifying',
      deviceName: 'Speed Sensor 2',
    });
  });

  it('detects the role from the first frame and writes stamped samples only while recording', async () => {
    const { transport, pair, sensor, written, record } = setup();
    await pair(SPEED);
    transport.frame(SPEED.id, wheel(100, 0));
    transport.frame(SPEED.id, wheel(102, 1024)); // 2 revs in 1 s
    expect(sensor(SPEED.id)?.role).toBe('speed');
    expect(sensor(SPEED.id)?.value).toBeGreaterThan(0);
    expect(written.speed).toHaveLength(0);

    record('rec-1');
    transport.frame(SPEED.id, wheel(104, 2048));
    expect(written.speed).toEqual([
      expect.objectContaining({
        recordingId: 'rec-1',
        wheelRevs: 104, // the cumulative counter, for wheel distance (MZY-282)
        deviceId: SPEED.id,
        deviceName: 'Speed Sensor 2',
        deviceKind: 'csc',
      }),
    ]);
  });

  it("reports an unrequested link drop as status 'disconnected'", async () => {
    const { transport, pair, sensor } = setup();
    await pair(CAD);
    transport.drop(CAD.id);
    expect(sensor(CAD.id)?.status).toBe('disconnected');
  });

  it('records only the primary of two cadence sensors and hands over on a drop', async () => {
    const { transport, pair, written, record } = setup();
    await pair(CAD);
    await pair(CAD2);
    record('rec-1');
    for (const id of [CAD.id, CAD2.id]) {
      transport.frame(id, crank(10, 0));
      transport.frame(id, crank(11, 1024));
    }
    expect(written.cadence.map((s) => s.deviceId)).toEqual([CAD.id]);

    transport.drop(CAD.id);
    transport.frame(CAD2.id, crank(12, 2048));
    expect(written.cadence.map((s) => s.deviceId)).toEqual([CAD.id, CAD2.id]);
  });

  it("ignores a power meter's crank cadence while a cadence sensor is connected", async () => {
    const { transport, pair, written, record } = setup();
    await pair(PM, 'power');
    await pair(CAD);
    record('rec-1');
    // The CSC sensor is a cadence sensor only once its first frame says so.
    transport.frame(CAD.id, crank(10, 0));
    transport.frame(CAD.id, crank(11, 1024));
    transport.frame(PM.id, power(200, 10, 0));
    transport.frame(PM.id, power(210, 11, 1024));
    expect(written.power.map((s) => s.watts)).toEqual([200, 210]);
    expect(written.cadence.map((s) => s.deviceId)).toEqual([CAD.id]);

    transport.drop(CAD.id);
    transport.frame(PM.id, power(220, 12, 2048));
    expect(written.cadence.map((s) => s.deviceId)).toEqual([CAD.id, PM.id]);
  });

  it('treats a cancelled picker as no error, and reports other failures', async () => {
    const { transport, hub, errors, pair, sensor } = setup();
    transport.nextPick(null);
    hub.connect('csc');
    await flush();
    expect(errors).toEqual([]);

    transport.failConnect(SPEED.id, 'GATT operation failed');
    await pair(SPEED);
    expect(sensor(SPEED.id)).toMatchObject({
      status: 'error',
      errorMessage: 'GATT operation failed',
    });
  });

  it('re-pairing a sensor replaces its subscription instead of doubling it', async () => {
    const { transport, pair } = setup();
    await pair(SPEED);
    await pair(SPEED);
    expect(transport.subscriberCount(SPEED.id)).toBe(1);
  });

  it('disconnect() closes the link and removes the sensor; dispose() closes the rest', async () => {
    const { transport, hub, pair, sensor } = setup();
    await pair(SPEED);
    await pair(CAD);
    hub.disconnect(SPEED.id);
    expect(transport.connected(SPEED.id)).toBe(false);
    expect(sensor(SPEED.id)).toBeUndefined();

    hub.dispose();
    expect(transport.connected(CAD.id)).toBe(false);
    expect(transport.subscriberCount(CAD.id)).toBe(0);
  });

  it('reports a runtime without Bluetooth', () => {
    const transport = createFakeBleTransport(false);
    const errors: string[] = [];
    const hub = createCyclingSensorHub({
      transport,
      setSensors: () => {},
      getRecordingId: () => null,
      onError: (m) => errors.push(m),
      append: {
        speed: async () => {},
        cadence: async () => {},
        power: async () => {},
      },
    });
    hub.connect('csc');
    expect(errors).toHaveLength(1);
    expect(transport.requested).toEqual([]);
  });
});
