// Screen-off keep-alive for app/record in the Android app (MZY-280), over the
// in-repo AgonRecordingPower plugin (android/.../RecordingPowerPlugin.java):
// a partial wake lock from Start to Stop (capped at 8 h natively) so BLE and
// GPS callbacks keep flowing with the screen off, and a one-time ask for the
// battery-optimisation exemption. Outside the Android app all no-ops.
// Pattern credits (OpenTracks, FitoTrack, OsmAnd): CREDITS.md.

import { registerPlugin } from '@capacitor/core';
import { isNativeApp } from './platform';

interface AgonRecordingPowerPlugin {
  acquireWakeLock(): Promise<void>;
  releaseWakeLock(): Promise<void>;
  isIgnoringBatteryOptimizations(): Promise<{ ignoring: boolean }>;
  requestIgnoreBatteryOptimizations(): Promise<{ ignoring: boolean }>;
}

const AgonRecordingPower =
  registerPlugin<AgonRecordingPowerPlugin>('AgonRecordingPower');

/** Remembered per device: the athlete was asked once; Settings is the way back. */
const ASKED_KEY = 'agon.batteryExemptionAsked';

export function holdAwakeForRecording(): void {
  if (!isNativeApp()) return;
  AgonRecordingPower.acquireWakeLock().catch(() => {});
}

export function releaseRecordingWakeLock(): void {
  if (!isNativeApp()) return;
  AgonRecordingPower.releaseWakeLock().catch(() => {});
}

/**
 * Before the first recording: if Android may still put Agon to sleep, show
 * its exemption dialog — once. A refusal is respected (docs/self-hosting/
 * android-app.md explains the Settings route and the maker-specific extras).
 */
export async function askBatteryExemptionOnce(): Promise<void> {
  if (!isNativeApp()) return;
  try {
    if (window.localStorage.getItem(ASKED_KEY)) return;
  } catch {
    // storage blocked: fall through and ask; the dialog is harmless
  }
  try {
    const { ignoring } =
      await AgonRecordingPower.isIgnoringBatteryOptimizations();
    if (!ignoring) await AgonRecordingPower.requestIgnoreBatteryOptimizations();
    window.localStorage.setItem(ASKED_KEY, '1');
  } catch {
    // never block a recording over this
  }
}
