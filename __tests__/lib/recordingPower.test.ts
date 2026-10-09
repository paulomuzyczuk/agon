import {
  askBatteryExemptionOnce,
  holdAwakeForRecording,
  releaseRecordingWakeLock,
} from '../../lib/recordingPower';

// Outside the Android app (the web/PWA, and this test) nothing reaches the
// AgonRecordingPower plugin — the recorder calls these unconditionally.
describe('recordingPower outside the Android app', () => {
  it('is a no-op', async () => {
    expect(() => holdAwakeForRecording()).not.toThrow();
    expect(() => releaseRecordingWakeLock()).not.toThrow();
    await expect(askBatteryExemptionOnce()).resolves.toBeUndefined();
  });
});
