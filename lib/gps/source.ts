// The recorder's GPS seam (MZY-281), the location counterpart of lib/ble/.
// app/record talks to the phone's location provider only through GpsSource,
// so the connection logic (app/record/gpsLink.ts) is unit-tested with a fake
// source. Only the Android app has a real implementation
// (lib/gps/nativeGeolocation.ts); the browser recorder stays GPS-less (a tab
// is frozen with the screen off, so its track would be unreliable).

import type { SampleDevice } from '@/lib/sourceDevices';

/** One location fix as the provider reports it. */
export interface GpsFix {
  tMs: number; // epoch ms the fix was produced
  lat: number;
  lng: number;
  altitudeM: number | null;
  accuracyM: number; // horizontal, 68% confidence
  speedMps: number | null;
  simulated: boolean;
}

export interface GpsWatchOptions {
  /**
   * true = keep delivering fixes with the app in the background (Android
   * runs a foreground service with a persistent notification). false =
   * foreground only, no notification — used to warm up a fix before Start.
   */
  background: boolean;
}

export interface GpsSource {
  /** False when this runtime has no usable location provider (the browser). */
  isAvailable(): boolean;
  /**
   * Starts a watcher; resolves to its stop function. Fixes and errors arrive
   * through the callbacks (event-driven, no timers — screen-off rule in
   * .claude/rules/live-recording.md).
   */
  watch(
    options: GpsWatchOptions,
    onFix: (fix: GpsFix) => void,
    onError: (err: Error) => void,
  ): Promise<() => Promise<void>>;
  /** Opens the app's system settings (to grant a denied location permission). */
  openSettings?(): Promise<void>;
}

/** Location permission was denied (or only "approximate" was granted and it can't track). */
export class GpsPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GpsPermissionError';
  }
}

/** The device stamp on every buffered GPS sample — one phone GPS per recording. */
export const PHONE_GPS_DEVICE: Required<SampleDevice> = {
  deviceId: 'phone-gps',
  deviceName: 'Phone GPS',
  deviceKind: 'gps',
};
