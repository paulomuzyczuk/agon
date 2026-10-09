import { createHeartRateLink } from '@/app/record/heartRateLink';
import type { HeartRateState } from '@/app/record/heartRate';
import type { HrSampleRecord } from '@/lib/liveRecordingDb';
import { BlePermissionError } from '@/lib/ble/transport';
import { createFakeBleTransport, flush, stateCell } from './fakeBleTransport';

// The recorder's HR strap state machine over a fake BleTransport (MZY-275).

const STRAP = { id: 'strap-1', name: 'HRM200' };
const hr = (bpm: number) => [0x00, bpm]; // flags 0: uint8 bpm, no contact bit

function setup(available = true) {
  const transport = createFakeBleTransport(available);
  const state = stateCell<HeartRateState>({ kind: 'idle' });
  const samples: HrSampleRecord[] = [];
  const counted: string[] = [];
  let recordingId: string | null = null;
  const link = createHeartRateLink({
    transport,
    setState: state.set,
    getRecordingId: () => recordingId,
    appendHrSample: async (s) => void samples.push(s),
    onSample: (id) => counted.push(id),
    now: () => 5_000,
  });
  async function pair() {
    transport.nextPick(STRAP);
    link.pair();
    await flush();
  }
  return {
    transport,
    state,
    samples,
    counted,
    link,
    pair,
    record: (id: string | null) => (recordingId = id),
  };
}

describe('heartRateLink', () => {
  it('pairs: requesting → connected, over the heart_rate service', async () => {
    const { transport, state, link } = setup();
    transport.nextPick(STRAP);
    link.pair();
    expect(state.get()).toEqual({ kind: 'requesting' });
    await flush();
    expect(transport.requested).toEqual(['heart_rate']);
    expect(state.get()).toMatchObject({
      kind: 'connected',
      deviceName: 'HRM200',
      bpm: null,
    });
  });

  it('shows each frame and buffers it, device-stamped, only while recording', async () => {
    const { transport, state, samples, counted, pair, record } = setup();
    await pair();
    transport.frame(STRAP.id, hr(142));
    expect(state.get()).toMatchObject({
      kind: 'connected',
      bpm: 142,
      lastUpdatedAt: 5_000,
    });
    expect(samples).toHaveLength(0);

    record('rec-1');
    transport.frame(STRAP.id, hr(150));
    expect(samples).toEqual([
      {
        recordingId: 'rec-1',
        tMs: 5_000,
        bpm: 150,
        sensorContact: 'not-supported',
        deviceId: STRAP.id,
        deviceName: 'HRM200',
        deviceKind: 'heart_rate',
      },
    ]);
    expect(counted).toEqual(['rec-1']);
  });

  it("a link drop becomes 'disconnected' with the last reading; Reconnect restores it", async () => {
    const { transport, state, link, pair } = setup();
    await pair();
    transport.frame(STRAP.id, hr(130));
    transport.drop(STRAP.id);
    expect(state.get()).toEqual({
      kind: 'disconnected',
      deviceName: 'HRM200',
      lastBpm: 130,
      lastUpdatedAt: 5_000,
    });

    link.reconnect();
    await flush();
    expect(state.get()).toMatchObject({ kind: 'connected' });
    expect(transport.connected(STRAP.id)).toBe(true);
  });

  it('an intentional disconnect goes to idle and closes the link', async () => {
    const { transport, state, link, pair } = setup();
    await pair();
    link.disconnect();
    expect(state.get()).toEqual({ kind: 'idle' });
    expect(transport.connected(STRAP.id)).toBe(false);
    expect(transport.subscriberCount(STRAP.id)).toBe(0);
  });

  it('a cancelled picker returns to idle; a failed connect shows the error', async () => {
    const { transport, state, link, pair } = setup();
    transport.nextPick(null);
    link.pair();
    await flush();
    expect(state.get()).toEqual({ kind: 'idle' });

    transport.failConnect(STRAP.id, 'Connection attempt failed');
    await pair();
    expect(state.get()).toEqual({
      kind: 'error',
      message: 'Connection attempt failed',
    });
    expect(transport.connected(STRAP.id)).toBe(false);
  });

  it('flags a denied Bluetooth permission so the page can offer settings', async () => {
    const { transport, state, link } = setup();
    transport.requestDevice = () => Promise.reject(new BlePermissionError());
    link.pair();
    await flush();
    expect(state.get()).toMatchObject({
      kind: 'error',
      permissionDenied: true,
    });
  });

  it('ignores a malformed frame', async () => {
    const { transport, state, pair } = setup();
    await pair();
    transport.frame(STRAP.id, [0x00]);
    expect(state.get()).toMatchObject({ kind: 'connected', bpm: null });
  });

  it('reports a runtime without Bluetooth as unsupported', () => {
    const { state, link, transport } = setup(false);
    expect(link.isAvailable()).toBe(false);
    link.pair();
    expect(state.get()).toEqual({ kind: 'unsupported' });
    expect(transport.requested).toEqual([]);
  });
});
