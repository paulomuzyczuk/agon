// GpsSource over the Android app's native location provider (MZY-281).
//
// Borrowed: @capacitor-community/background-geolocation 1.2.26 — MIT
// (c) James Diacono; used as a dependency, no source copied. See CREDITS.md.
//
// A watcher with `backgroundMessage` set runs the plugin's foreground service
// (type "location", persistent notification), which keeps fixes — and, per
// the MZY-273 spike, BLE notifications — arriving with the screen off. It
// needs `android.useLegacyBridge: true` (capacitor.config.ts) or updates stop
// after ~5 min in the background. The plugin doesn't ask for
// POST_NOTIFICATIONS (Android 13+), without which the notification is hidden,
// so a background watcher first asks through the in-repo AgonNotifications
// plugin (android/.../NotificationPermissionPlugin.java).

import { registerPlugin } from '@capacitor/core';
import type {
  BackgroundGeolocationPlugin,
  Location,
} from '@capacitor-community/background-geolocation';
import { GpsPermissionError, type GpsFix, type GpsSource } from './source';

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>(
  'BackgroundGeolocation',
);

interface AgonNotificationsPlugin {
  request(): Promise<{ granted: boolean }>;
}
const AgonNotifications =
  registerPlugin<AgonNotificationsPlugin>('AgonNotifications');

const DENIED_MESSAGE =
  'Location permission denied. Allow precise location for Agon in Android Settings → Apps → Agon → Permissions.';

/** Plugin location → GpsFix, or null for a fix with no usable time. */
export function toGpsFix(loc: Location): GpsFix | null {
  if (loc.time == null) return null;
  return {
    tMs: loc.time,
    lat: loc.latitude,
    lng: loc.longitude,
    altitudeM: loc.altitude ?? null,
    accuracyM: loc.accuracy,
    speedMps: loc.speed ?? null,
    simulated: loc.simulated,
  };
}

export function mapGpsError(err: { code?: string; message?: string }): Error {
  if (err.code === 'NOT_AUTHORIZED')
    return new GpsPermissionError(DENIED_MESSAGE);
  return new Error(err.message || 'Location error');
}

export function createNativeGpsSource(): GpsSource {
  return {
    isAvailable: () => true,

    async watch({ background }, onFix, onError) {
      if (background) {
        // A refusal only hides the notification; recording still works.
        await AgonNotifications.request().catch(() => undefined);
      }
      const id = await BackgroundGeolocation.addWatcher(
        {
          ...(background
            ? {
                backgroundTitle: 'Agon is recording',
                backgroundMessage:
                  'Recording your activity. Stop it in the app.',
              }
            : {}),
          requestPermissions: true,
          stale: false,
          distanceFilter: 0,
        },
        (location, error) => {
          if (error) {
            onError(mapGpsError(error));
            return;
          }
          const fix = location ? toGpsFix(location) : null;
          if (fix) onFix(fix);
        },
      );
      return async () => {
        await BackgroundGeolocation.removeWatcher({ id }).catch(() => {});
      };
    },

    openSettings: () => BackgroundGeolocation.openSettings(),
  };
}
