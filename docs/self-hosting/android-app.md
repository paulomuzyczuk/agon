# Android app (Capacitor shell)

Agon's Android app is a thin native shell
([Capacitor](https://capacitorjs.com/), MIT) around **your own** self-hosted
Agon. It doesn't bundle a copy of the site: it loads your server's URL and
shows exactly the pages Chrome would. It exists because a browser tab or
installed PWA gets frozen when the screen is off. A native app can run a
foreground service ("Agon is recording"), so the recorder (`/record`) keeps
capturing heart rate and GPS during a run.

It's a **sideloaded APK**: you build and sign it yourself and install it
directly. There's no Play Store listing. Android only; iOS is out of scope.

> Status: on top of the shell (MZY-274) sit native Bluetooth (MZY-279),
> background GPS with its foreground service (MZY-281), a native sample
> journal that survives the app being killed mid-recording (MZY-294), and
> a wake lock plus battery exemption for screen-off recording (MZY-280).

## What you need

- A running Agon reachable from the phone over **HTTPS** (see the next
  section).
- On the machine that builds the APK (macOS shown; Linux is the same with
  your package manager):

  ```sh
  brew install openjdk@21 android-commandlinetools
  export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
  export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
  export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
  sdkmanager --sdk_root="$ANDROID_HOME" "platform-tools" "platforms;android-36" "build-tools;36.0.0"
  yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
  ```

  Put the three `export` lines in your shell profile. The `temurin@21` cask
  also works, but its installer needs `sudo`; the `openjdk@21` formula doesn't.

## The server URL must be HTTPS

Set `AGON_ANDROID_SERVER_URL` in `.env.local`. It is baked into the APK when
you sync, so after changing it, re-run `pnpm android:build`.

The app refuses a plain `http://` URL to a LAN or Tailscale IP. The WebView
treats such an origin as insecure. There, `crypto.randomUUID` doesn't exist,
so the recorder can't start a recording, and the offline service worker never
registers (found in the MZY-273 spike). Two options:

- **Your tower (recommended): Tailscale HTTPS.** In the Tailscale admin
  console, go to *DNS → enable MagicDNS + HTTPS Certificates*. Then on the
  tower run `tailscale serve --bg 3000`. Your URL is
  `https://<machine>.<tailnet>.ts.net`. Note that HTTPS certificates publish
  machine names in public Certificate Transparency logs.
- **Development: loopback over USB.** Run `adb reverse tcp:3000 tcp:3000` with
  the phone plugged in, and set `http://127.0.0.1:3000`. Loopback counts as
  secure. Once the page has loaded, the cable can come out.

IndexedDB (the recorder's write-ahead buffer) is stored **per origin**.
Flush or discard any unfinished recordings *before* you point the app at a
different URL, or they stay behind under the old one.

## Create your signing key (once)

Android only installs an update over an existing app when it carries the
**same signature**. Keep the keystore outside the repo and back it up. If you
lose it, the phone refuses every future APK until you uninstall the app, and
uninstalling deletes any unflushed recordings.

```sh
mkdir -p ~/.agon && chmod 700 ~/.agon
keytool -genkeypair -v -keystore ~/.agon/agon-release.jks \
  -alias agon -keyalg RSA -keysize 4096 -validity 36500 \
  -dname "CN=Agon self-hosted"
```

Then add to `.env.local` (secrets never go in `.env.example`):

```sh
AGON_ANDROID_KEYSTORE_PATH=/Users/<you>/.agon/agon-release.jks   # absolute
AGON_ANDROID_KEYSTORE_PASSWORD=...
AGON_ANDROID_KEY_ALIAS=agon
AGON_ANDROID_KEY_PASSWORD=...
```

## Build

```sh
pnpm android:build
```

This validates the URL and the signing env first. It refuses a keystore
inside the repo or a missing one, with a one-line error. It then syncs
`capacitor.config.ts` into `android/`, runs Gradle's `assembleRelease`,
verifies the signature with `apksigner`, and prints the APK path
(`android/app/build/outputs/apk/release/app-release.apk`).

Each build gets a higher `versionCode` (minutes since 2026-01-01), so a new
APK always installs as an update. `pnpm android:sync` alone just copies the
config, e.g. before opening `android/` in Android Studio.

## Install (sideload) and update

- **USB:** turn on *Developer options → USB debugging*, plug in, then run
  `adb install -r android/app/build/outputs/apk/release/app-release.apk`.
- **No cable:** copy the APK to the phone (Drive, a messenger, email), open
  it, and allow *Install unknown apps* for that source.

Updating is the same command or file with a newer build. Data (login cookie,
buffered recordings) survives as long as the signing key is the same.

On first launch, log in with your normal Agon secret. The session cookie
persists across app restarts.

## Phone settings

- **Battery:** the first time you tap *Start recording*, Android asks
  whether to let Agon always run in the background. Say **Allow**: it
  exempts the app from battery optimisation, so Doze doesn't throttle a
  screen-off recording. You're asked once. To change it later, go to
  *Settings → Apps → Agon → Battery → Unrestricted*. While recording, the
  app also holds a partial wake lock (CPU only, the screen still sleeps).
  It's released on Stop, and capped at 8 h in case a Stop never happens.
- **Your phone maker's own battery manager** can still kill apps that
  Android itself would keep alive. Check
  [dontkillmyapp.com](https://dontkillmyapp.com) for your brand. On
  Samsung (One UI): *Settings → Battery → Background usage limits* — make
  sure Agon is not under *Sleeping apps* or *Deep sleeping apps*, and add
  it to *Never sleeping apps*. Even if the app is killed mid-recording,
  the samples up to that moment are kept (MZY-294) and show up under
  *Unfinished recordings* the next time you open Record.
- **Backups are off by design** (`allowBackup=false`). Android's auto-backup
  restarted the app mid-recording in testing, and it would upload the
  WebView's data, session cookie included, to Google.

- **Bluetooth ("Nearby devices"):** asked the first time you tap *Connect*
  on the Record page. The app uses native Bluetooth here, because Android's
  WebView has no Web Bluetooth. It declares `neverForLocation`, so pairing a
  strap doesn't need location. If you denied the prompt, the Record page
  offers *Open settings*: grant *Permissions → Nearby devices*. Bluetooth
  itself must be on. Garmin straps must be in open mode (3 green flashes).

## Debugging the app's WebView

Set `AGON_ANDROID_WEBVIEW_DEBUG=1`, run `pnpm android:build`, and install as
usual. Chrome's `chrome://inspect` on the computer then lists the app's
WebView over USB. The build is still release-signed, so it updates over your
installed app without losing the login. Rebuild without the flag afterwards.

## When the server is unreachable

When the app can't reach your server and the service worker has no cached
copy, it shows a local "server unreachable" page (`android-shell/offline.html`)
with a Retry button. Pages the PWA caches offline behave the same in the app
in a production build (`pnpm build` + `pnpm start`, or Docker). The service
worker doesn't register under `pnpm dev`.

## Repo layout

- `capacitor.config.ts`: app id `dev.agon.app`, name, `server.url` from env.
- `lib/androidShell.ts`: URL and signing-env rules (unit-tested).
- `lib/platform.ts`: the single "am I in the native app?" check.
- `android/`: the generated Gradle project (committed; excluded from
  Prettier, and outside the lint and file-size-budget scopes).
- `android-shell/`: the only web files inside the APK (the offline fallback).
- `scripts/build-android.ts`: `pnpm android:build`.

There's no CI build of the APK: the repo has no CI pipeline, and signing
needs your private keystore anyway.
