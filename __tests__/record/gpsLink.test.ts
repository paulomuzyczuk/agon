import { createGpsLink, type GpsState } from '@/app/record/gpsLink';
import type { GpsSampleRecord } from '@/lib/liveRecordingDb';
import {
  GpsPermissionError,
  type GpsFix,
  type GpsSource,
} from '@/lib/gps/source';
import { flush } from './fakeBleTransport';

// The recorder's phone-GPS state machine over a fake GpsSource (MZY-281).

const T0 = 1_760_000_000_000;

interface Watcher {
  background: boolean;
  onFix: (f: GpsFix) => void;
  onError: (e: Error) => void;
  stopped: boolean;
}

function fakeSource(available = true) {
  const watchers: Watcher[] = [];
  let failNext: Error | null = null;
  const source: GpsSource = {
    isAvailable: () => available,
    async watch({ background }, onFix, onError) {
      if (failNext) {
        const err = failNext;
        failNext = null;
        throw err;
      }
      const w: Watcher = { background, onFix, onError, stopped: false };
      watchers.push(w);
      return async () => {
        w.stopped = true;
      };
    },
  };
  return {
    source,
    watchers,
    active: () => watchers.filter((w) => !w.stopped),
    failWith: (e: Error) => (failNext = e),
    /** Delivers a fix to every live watcher, as the plugin does. */
    fix: (f: GpsFix) =>
      watchers.filter((w) => !w.stopped).forEach((w) => w.onFix(f)),
  };
}

const fix = (s: number, northM: number, accuracyM = 4.2): GpsFix => ({
  tMs: T0 + s * 1000,
  lat: 52.4731234 + northM / 111_320,
  lng: 13.4012345,
  altitudeM: 41.3,
  accuracyM,
  speedMps: 3.12,
  simulated: false,
});

function setup(available = true) {
  const fake = fakeSource(available);
  let state: GpsState = { kind: 'idle' };
  const samples: GpsSampleRecord[] = [];
  const counted: string[] = [];
  const link = createGpsLink({
    source: fake.source,
    setState: (s) => (state = s),
    appendGpsSample: async (s) => void samples.push(s),
    onSample: (id) => counted.push(id),
  });
  return { fake, link, samples, counted, state: () => state };
}

describe('gpsLink', () => {
  it('is unsupported without a GPS source (the browser)', async () => {
    const { link, state } = setup(false);
    await link.warmUp();
    expect(state()).toEqual({ kind: 'unsupported' });
  });

  it('warms up in the foreground and shows accuracy, buffering nothing', async () => {
    const { fake, link, samples, state } = setup();
    await link.warmUp();
    expect(state()).toEqual({ kind: 'acquiring' });
    expect(fake.active().map((w) => w.background)).toEqual([false]);
    fake.fix(fix(0, 0, 6.4));
    expect(state()).toMatchObject({ kind: 'ok', accuracyM: 6.4, distanceM: 0 });
    fake.fix(fix(1, 0, 48));
    expect(state()).toMatchObject({ kind: 'weak', accuracyM: 48 });
    expect(samples).toEqual([]);
  });

  it('hands off to a background watcher on Start, then back on Stop', async () => {
    const { fake, link } = setup();
    await link.warmUp();
    await link.startRecording('rec-1', T0);
    expect(fake.active().map((w) => w.background)).toEqual([true]);
    await link.stopRecording();
    expect(fake.active().map((w) => w.background)).toEqual([false]);
  });

  it('buffers accepted fixes, GPS-stamped, and tracks distance', async () => {
    const { fake, link, samples, counted, state } = setup();
    await link.warmUp();
    await link.startRecording('rec-1', T0);
    fake.fix(fix(0, 0));
    fake.fix(fix(0, 0)); // the duplicate a hand-off can deliver
    fake.fix(fix(1, 3.1));
    fake.fix(fix(2, 6.3, 31.2)); // too inaccurate
    fake.fix(fix(3, 9.4));
    expect(samples).toHaveLength(3);
    expect(samples[0]).toEqual({
      recordingId: 'rec-1',
      tMs: T0,
      lat: 52.4731234,
      lng: 13.4012345,
      altitudeM: 41.3,
      accuracyM: 4.2,
      speedMps: 3.12,
      deviceId: 'phone-gps',
      deviceName: 'Phone GPS',
      deviceKind: 'gps',
    });
    expect(counted).toEqual(['rec-1', 'rec-1', 'rec-1']);
    const s = state();
    expect(s.kind).toBe('ok');
    if (s.kind === 'ok') expect(s.distanceM).toBeCloseTo(9.4, 0);
  });

  it('stops buffering after Stop', async () => {
    const { fake, link, samples } = setup();
    await link.startRecording('rec-1', T0);
    fake.fix(fix(0, 0));
    await link.stopRecording();
    fake.fix(fix(1, 3));
    expect(samples).toHaveLength(1);
  });

  it('shows a denied permission with the settings hint', async () => {
    const { fake, link, state } = setup();
    fake.failWith(new GpsPermissionError('Location permission denied.'));
    await link.warmUp();
    expect(state()).toEqual({
      kind: 'error',
      message: 'Location permission denied.',
      permissionDenied: true,
    });
  });

  it('removes a watcher that resolves after dispose', async () => {
    const { fake, link } = setup();
    const pending = link.warmUp();
    link.dispose();
    await pending;
    await flush();
    expect(fake.active()).toEqual([]);
  });
});
