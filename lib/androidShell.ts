// Server URL rules for the Capacitor Android shell (MZY-274; capacitor.config.ts
// is the only caller). The shell loads the self-hosted site via server.url —
// Next has server API routes, so there is no static bundle to ship.
//
// The URL must be a SECURE origin (MZY-273 spike finding): over plain HTTP the
// WebView has no `crypto.randomUUID` (lib/liveRecordingDb.ts createRecording
// throws) and the service worker never registers. HTTPS (e.g. `tailscale
// serve` on the tower) or loopback (`adb reverse` in dev) only.

import { z } from 'zod';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface AndroidServerConfig {
  url: string;
  /** Plain-HTTP traffic allowed in the WebView — loopback dev only. */
  cleartext: boolean;
}

const serverUrlSchema = z
  .string({
    required_error:
      'AGON_ANDROID_SERVER_URL is required, e.g. https://<tower>.<tailnet>.ts.net or http://127.0.0.1:3000 (dev via adb reverse)',
  })
  .trim()
  .url('AGON_ANDROID_SERVER_URL must be an absolute URL')
  .transform((raw) => new URL(raw))
  .refine(
    (url) =>
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)),
    {
      message:
        'AGON_ANDROID_SERVER_URL must be https:// (or http:// to localhost/127.0.0.1 for dev) — ' +
        'a plain-HTTP origin is not a secure context, so the recorder and the service worker break',
    },
  )
  .refine((url) => url.pathname === '/' && !url.search && !url.hash, {
    message:
      'AGON_ANDROID_SERVER_URL must be an origin only (no path, query or fragment)',
  });

export function parseAndroidServerUrl(
  raw: string | undefined,
): AndroidServerConfig {
  const url = serverUrlSchema.parse(raw);
  return { url: url.origin, cleartext: url.protocol === 'http:' };
}

// Release-signing env for scripts/build-android.ts. The keystore must live
// OUTSIDE the repo (a stray `git add -f` can't reach it) — losing it means the
// phone refuses every future APK as an update, so it is backed up by hand.
export interface AndroidSigningEnv {
  keystorePath: string;
  keyAlias: string;
}

const required = (name: string) =>
  z
    .string({
      required_error: `${name} is required for a signed release build`,
    })
    .trim()
    .min(1, `${name} is empty`);

export function parseAndroidSigningEnv(
  env: Record<string, string | undefined>,
  repoRoot: string,
  pathExists: (path: string) => boolean,
): AndroidSigningEnv {
  const parsed = z
    .object({
      AGON_ANDROID_KEYSTORE_PATH: required('AGON_ANDROID_KEYSTORE_PATH')
        .refine(
          (p) => p.startsWith('/'),
          'AGON_ANDROID_KEYSTORE_PATH must be an absolute path',
        )
        .refine(
          (p) =>
            !(
              p === repoRoot || p.startsWith(`${repoRoot.replace(/\/$/, '')}/`)
            ),
          'AGON_ANDROID_KEYSTORE_PATH must point outside the repo (e.g. ~/.agon/agon-release.jks)',
        )
        .refine(
          pathExists,
          'AGON_ANDROID_KEYSTORE_PATH does not exist — create it first (docs/self-hosting/android-app.md)',
        ),
      AGON_ANDROID_KEYSTORE_PASSWORD: required(
        'AGON_ANDROID_KEYSTORE_PASSWORD',
      ),
      AGON_ANDROID_KEY_ALIAS: required('AGON_ANDROID_KEY_ALIAS'),
      AGON_ANDROID_KEY_PASSWORD: required('AGON_ANDROID_KEY_PASSWORD'),
    })
    .parse(env);
  return {
    keystorePath: parsed.AGON_ANDROID_KEYSTORE_PATH,
    keyAlias: parsed.AGON_ANDROID_KEY_ALIAS,
  };
}

/**
 * Monotonic Android versionCode: minutes since 2026-01-01 UTC. Each build
 * installs as an update over the last one without a hand-bumped counter, and
 * stays far below Android's 2,100,000,000 ceiling for millennia.
 */
export function androidVersionCode(nowMs: number): number {
  return Math.max(1, Math.floor((nowMs - Date.UTC(2026, 0, 1)) / 60_000));
}
