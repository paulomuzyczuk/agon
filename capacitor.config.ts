// Capacitor Android shell (MZY-272/MZY-274). Capacitor (MIT) — see CREDITS.md.
//
// The shell loads the self-hosted Agon site through server.url (Next has server
// API routes, so there is no static bundle). The URL is never hardcoded
// (self-hosting rule): AGON_ANDROID_SERVER_URL from the env / .env.local, read
// at `cap sync` time and baked into the APK — change it, then re-sync and
// rebuild. Rules (secure origin only): lib/androidShell.ts.
//
//   pnpm android:sync    copy this config + web assets into android/
//   pnpm android:build   signed release APK (scripts/build-android.ts)
//   docs/self-hosting/android-app.md
import type { CapacitorConfig } from '@capacitor/cli';
import { parseAndroidServerUrl } from './lib/androidShell';
import { loadEnv } from './scripts/loadEnv';

loadEnv();
const server = parseAndroidServerUrl(process.env.AGON_ANDROID_SERVER_URL);

const config: CapacitorConfig = {
  appId: 'dev.agon.app',
  appName: 'Agon',
  // Only the offline fallback ships inside the APK — every real page comes
  // from server.url.
  webDir: 'android-shell',
  server: {
    url: server.url,
    cleartext: server.cleartext,
    errorPath: 'offline.html',
  },
  android: {
    // Required by @capacitor-community/background-geolocation (MZY-281) —
    // without it location updates halt after ~5 min in the background
    // (plugin README / its issue #89). Set from the start so the shell's
    // bridge behaviour doesn't change under the recorder later.
    useLegacyBridge: true,
    // Opt-in Chrome DevTools inspection of a release-signed build
    // (AGON_ANDROID_WEBVIEW_DEBUG=1 at `cap sync` time), so debugging on the
    // phone never needs a debug-signed APK — which can't update over the
    // release-signed app and would force an uninstall (losing the login and
    // any buffered recordings). Off by default.
    webContentsDebuggingEnabled: process.env.AGON_ANDROID_WEBVIEW_DEBUG === '1',
  },
};

export default config;
