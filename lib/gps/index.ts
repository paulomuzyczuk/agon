import { isNativeApp } from '@/lib/platform';
import { createNativeGpsSource } from './nativeGeolocation';
import type { GpsSource } from './source';

// The recorder's one GpsSource for this runtime: the native provider inside
// the Android shell (MZY-281); none in the browser, which stays GPS-less.
// Chosen via lib/platform.ts, the single runtime check.

const unavailable: GpsSource = {
  isAvailable: () => false,
  watch: () =>
    Promise.reject(new Error('GPS is only recorded in the Agon Android app')),
};

let source: GpsSource | null = null;

export function getGpsSource(): GpsSource {
  source ??= isNativeApp() ? createNativeGpsSource() : unavailable;
  return source;
}

export * from './source';
