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

// A standing wheel / still crank keeps notifying with an UNCHANGED event time.
// That used to leave no sample (stored as null, indistinguishable from a
// sensor dropout); now it is a real 0 once the timeout passes. The test clock
// advances 1 s per frame, so STOPPED_AFTER_MS.wheel (3 s) = 3 repeated frames
// and .crank (4 s) = 4.
describe('cyclingSensorHub — a standing sensor reads 0', () => {
  async function riding() {
    const ctx = setup();
    await ctx.pair(SPEED);
    ctx.record('rec-1');
    ctx.transport.frame(SPEED.id, wheel(100, 0)); // baseline
    ctx.transport.frame(SPEED.id, wheel(102, 1024)); // 2 revs in 1 s
    return ctx;
  }

  it('records 0 km/h once the wheel event time has not moved for 3 s', async () => {
    const { transport, written, sensor } = await riding();
    expect(written.speed).toHaveLength(1);

    transport.frame(SPEED.id, wheel(102, 1024)); // 1 s
    transport.frame(SPEED.id, wheel(102, 1024)); // 2 s
    expect(written.speed).toHaveLength(1); // a slow turn can repeat — not yet

    transport.frame(SPEED.id, wheel(102, 1024)); // 3 s
    expect(written.speed).toHaveLength(2);
    expect(written.speed[1]).toMatchObject({
      speedKmh: 0,
      wheelRevs: 102, // the counter did not move: wheel distance is unchanged
      deviceId: SPEED.id,
    });
    expect(sensor(SPEED.id)?.value).toBe(0);
  });

  it('keeps recording 0 while standing and restarts the timeout on a new event', async () => {
    const { transport, written } = await riding();
    for (let i = 0; i < 4; i++) transport.frame(SPEED.id, wheel(102, 1024));
    expect(written.speed.map((s) => s.speedKmh)).toEqual([
      expect.any(Number),
      0,
      0,
    ]);

    transport.frame(SPEED.id, wheel(104, 2048)); // rolling again
    expect(written.speed.at(-1)?.speedKmh).toBeGreaterThan(0);

    const before = written.speed.length;
    transport.frame(SPEED.id, wheel(104, 2048));
    transport.frame(SPEED.id, wheel(104, 2048));
    expect(written.speed).toHaveLength(before); // the 3 s runs from the new event
  });

  it('reads 0 for a bike that never started moving after pairing', async () => {
    const { transport, pair, written, record } = setup();
    await pair(SPEED);
    record('rec-1');
    transport.frame(SPEED.id, wheel(100, 0)); // baseline only
    transport.frame(SPEED.id, wheel(100, 0));
    transport.frame(SPEED.id, wheel(100, 0));
    expect(written.speed).toHaveLength(0);
    transport.frame(SPEED.id, wheel(100, 0)); // 3 s after the baseline
    expect(written.speed).toEqual([expect.objectContaining({ speedKmh: 0 })]);
  });

  it('shows 0 on screen while not recording, and writes nothing', async () => {
    const { transport, pair, sensor, written } = setup();
    await pair(SPEED);
    transport.frame(SPEED.id, wheel(100, 0));
    transport.frame(SPEED.id, wheel(102, 1024));
    for (let i = 0; i < 3; i++) transport.frame(SPEED.id, wheel(102, 1024));
    expect(sensor(SPEED.id)?.value).toBe(0);
    expect(written.speed).toHaveLength(0);
  });

  it('records 0 rpm once the crank has been still for 4 s (coasting)', async () => {
    const { transport, pair, written, record, sensor } = setup();
    await pair(CAD);
    record('rec-1');
    transport.frame(CAD.id, crank(10, 0)); // baseline
    transport.frame(CAD.id, crank(11, 1024)); // 60 rpm
    expect(written.cadence.map((s) => s.rpm)).toEqual([60]);

    for (let i = 0; i < 3; i++) transport.frame(CAD.id, crank(11, 1024));
    expect(written.cadence).toHaveLength(1); // 3 s: a slow turn is still possible

    transport.frame(CAD.id, crank(11, 1024)); // 4 s
    expect(written.cadence.map((s) => s.rpm)).toEqual([60, 0]);
    expect(sensor(CAD.id)?.value).toBe(0);
  });

  it("records 0 cadence from a power meter's still crank, for the primary cadence source", async () => {
    const { transport, pair, written, record } = setup();
    await pair(PM, 'power');
    record('rec-1');
    transport.frame(PM.id, power(200, 10, 0));
    transport.frame(PM.id, power(200, 11, 1024));
    for (let i = 0; i < 4; i++) transport.frame(PM.id, power(0, 11, 1024));
    expect(written.cadence.map((s) => s.rpm)).toEqual([60, 0]);
  });

  it('does not invent a reading when a sensor drops out (no frames, no 0)', async () => {
    const { transport, written } = await riding();
    transport.drop(SPEED.id);
    expect(written.speed).toHaveLength(1); // the dropout stays a gap — null in the stream
  });
});
