---
paths:
  - 'app/record/**'
  - 'app/heart-rate/**'
  - 'lib/bluetoothHeartRate.ts'
  - 'lib/bluetoothCycling.ts'
  - 'lib/liveRecordingDb.ts'
  - 'lib/gear.ts'
  - 'services/liveRecording.ts'
  - 'services/liveRecordingRide.ts'
  - 'app/api/live-recording/**'
---

# Live Run Recording — BLE + Local Write-Ahead Buffer

Full build/verification narrative: tracked in Linear. Motivation: Strava
premium keeps lapsing, Garmin's Connect API is partner-gated — but any HR
strap broadcasts the open, standard BLE Heart Rate GATT service (0x180D),
readable by any Web Bluetooth client with no vendor API needed.

## ⚠️ Garmin HRM 200 gotcha — read this before debugging a "won't connect" issue

The strap has TWO Bluetooth connection modes, and only ONE works with a
generic (non-Garmin) client:

- **Secure mode** (2 green LED flashes, the ships-in default): Garmin's own
  proprietary pairing handshake. It connects and even _advertises_ normally
  — device discovery, pairing, and battery all look fine — but silently
  refuses deeper GATT operations (service/characteristic access, enabling
  notifications) to anything that isn't Garmin's own app. This produces
  `NotFoundError`/"Connection attempt failed" (Android) or "GATT operation
  failed for unknown reason" (macOS), with NO indication the actual problem
  is the connection mode.
- **Open mode** (3 green LED flashes) is what Garmin's manual documents as
  "recommended for Bluetooth pairing with third-party smartwatches, tablets,
  or fitness equipment" — required for Web Bluetooth or any generic BLE
  client.
- **To switch**: wake the strap (1 press), double-press quickly to toggle
  secure↔open (confirm 3 green flashes = open), then hold 4 seconds to enter
  pairing mode (continuous orange LED, 5-minute window). Persists across
  power cycles — a one-time fix per strap, but a sharp trap for any other
  Garmin sensor model, since nothing in the Web Bluetooth API surfaces
  "wrong mode" as distinguishable from "device broken."

## Write-ahead buffer design

`lib/liveRecordingDb.ts` wraps IndexedDB (`agon-live-recording` DB) — a
`recordings` header store plus **one object store per metric** (mirrors how
`run_streams`/`ride_streams` themselves keep one typed array per metric under
a single row): `hr_samples`, `speed_samples`, `cadence_samples` (added by
MZY-168), `power_samples` (MZY-270, DB version 3), `gps_samples` (MZY-281,
DB **version 4**) — each upgrade only creates missing stores, so an older
install keeps its buffered recordings. The pure stream builders and
summaries live in `lib/liveRecordingStreams.ts`. Every parsed BLE
notification (~1/s) writes one sample immediately — no batching needed at
that rate. On mount, any recording left `status !==
'flushed'` surfaces in an "unfinished recordings" list (a killed tab or
offline Stop never loses data) — the same list handles crash-recovery and
retry-after-offline, with a Discard option. The header now also carries
`activityType: 'run' | 'ride'` (optional — a pre-MZY-168 header on disk has
none, treated as `'run'` everywhere it's read) so a resumed flush after a
reload knows which finish endpoint and which sample stores to read.

On Save, the distance is derived (MZY-282, see "GPS capture" below) or typed
as an override — `runs.distance_km`/`rides.distance_km` are both `NUMERIC(7,3)
NOT NULL CHECK > 0` — then `POST /api/live-recording/finish` (run) or
`/finish-ride` (ride) → `services/liveRecording.ts::finishLiveRecording()` /
`services/liveRecordingRide.ts::finishLiveRecordingRide()` derive
`duration_s`/avg+max HR (and avg+max speed, for a ride) and call the
existing, unmodified `upsertRun`/`upsertRide` with `source:
'live_recording'`, a client-generated recording UUID as `external_id` —
reusing the shared `(source, external_id)` idempotency key (see
`.claude/rules/run-ingestion.md`) makes a retried flush automatically safe.
The `runs`/`rides` row is created only on a successful flush, never on Start
— nothing valid to insert while distance is unknown. `source='live_recording'`
is named for the mechanism (browser-side live capture), not the transport
(today's HR/speed/cadence are BLE; a later GPS array from browser Geolocation
would land in the SAME `run_streams`/`ride_streams` row, PK
`run_id+source`/`ride_id+source`).

## Cycling sensors (Garmin Speed Sensor 2 / Cadence Sensor 2 — MZY-168)

Same open-standard precedent as the HR strap, one service over: both sensors
broadcast the BLE **Cycling Speed and Cadence (CSC) service (0x1816)**,
decoded by `lib/bluetoothCycling.ts::parseCscMeasurement` (Measurement
characteristic 0x2A5B). They are **two separate physical devices**, not one
combo unit — each BLE connection's Measurement flags carry exactly ONE of
{wheel-revolution data, crank-revolution data}, never both, so `app/record`
identifies a paired sensor's role (speed vs. cadence) from its first
notification rather than from a device-picker choice. A stationary sensor
still notifies at a steady rate with an unchanged event time (not silence) —
every delta computation treats a zero elapsed time as "no new sample," not a
division by zero, and both the uint16 event-time counter and the uint32
wheel-rev / uint16 crank-rev counters roll over and are handled accordingly.

**Wheel circumference** lives on `lib/gear.ts`'s `GearSpec` (new
`wheelCircumferenceMm` field, bike-only) rather than
`config/athlete-profile.local.json`: the athlete profile module holds scalar
training-program anchors, not per-item equipment specs, and `gear.ts` already
had the (previously unused) `'bike'` category plus the exact
seed-const-mirroring-`POLAR_H9`/`GARMIN_HRM_200` pattern this needed —
`MERIDA_SILEX_400`. It's a single current bike, not a dated timeline like
`HRM_TIMELINE`: the athlete has owned exactly one bike since ride tracking
began, so a per-date lookup would model a scenario that doesn't exist yet —
a second bike later adds a segment list, mirroring the HRM timeline, rather
than a rewrite. Every live-recorded ride is unconditionally linked to it via
`ride_gear` (same "no ambiguity, only one bike exists" reasoning).

**Merging three independently-notifying sensors into one `ride_streams` row**:
HR, speed, and cadence samples arrive on three separate ~1/s BLE
subscriptions that are never in lockstep with each other, but `ride_streams`
has one row per `(ride_id, source)` with index-aligned arrays. **Requires
`lib/liveRecordingStreams.ts::toRideStreamData`** to bucket every sample to the
nearest second from recording start, union the buckets that got at least one
sample into the shared `time_s` axis, and leave a metric `null` in a bucket
no sample landed in (same "null means a sensor dropped out" convention as
`RunStreamData`) — a metric absent for the WHOLE recording (that sensor was
never connected) is omitted entirely rather than sent as all-null.

**Wheel distance (MZY-282).** Each speed sample also stores the sensor's
cumulative uint32 `wheelRevs`; `lib/liveRecordingDistance.ts
wheelDistanceM` sums last − first per device (rollover-safe; counting
carries on through a BLE drop) × `wheelCircumferenceMm`. It is the ride's
distance only when there is no typed distance and no GPS track (indoors, or
recorded in the browser) — the athlete chose GPS over wheel.

**File-import path**: already covered, not a gap needing new work. GPX/TCX
cadence/speed extension fields were already parsed generically (not
run-specific) — `services/fileImport/gpx.ts`/`tcx.ts`/`track.ts`'s `<Cadence>`/
`<Speed>` tags — and Google Health's ride ingest
(`services/googleHealth/rideIngest.ts`) already reuses the same
`fetchGoogleHealthRunStreams` → `upsertRideStreams` path runs use, writing
cadence/`velocity_smooth_mps` into `ride_streams` for any Garmin-Connect- or
Strava-sourced TCX ride today. The one real gap — a generic **ride** file
importer CLI mirroring `services/fileImport/import.ts` (which is run-only) —
isn't Garmin-BLE-sensor-related and is out of scope here.

## Power meter — BLE Cycling Power (MZY-270)

Any power meter (pedals, crank, hub, smart trainer) broadcasts the open
**Cycling Power service (0x1818)**; its Measurement characteristic (0x2A63)
is decoded by `lib/bluetoothPower.ts::parseCyclingPowerMeasurement`: uint16
flags, sint16 instantaneous W, then the optional fields **in flag order**
(balance, torque, wheel, crank, extreme force/torque, angles, dead spots,
energy). Returns null on a short frame, never throws.

- ⚠️ **Wheel event time is 1/2048 s here, 1/1024 s in CSC.** Crank event time
  is 1/1024 s in both. Use `computePowerWheelSpeedKmh` for power-meter wheel
  data, never CSC's `computeWheelSpeedKmh`, or the speed is doubled.
- Paired with its own "Connect a power meter" button
  (`app/record/cyclingSensorHub.ts`, wrapped by `useCyclingSensors.ts` — the
  ride-only sensors all live there). Watts are
  clamped to 0-3000 and written to `power_samples`.
- **Power meter as cadence source**: its crank data is written to
  `cadence_samples` only while no CSC cadence sensor is connected, so two
  sources never collide in one 1 s bucket of `toRideStreamData`. The live
  cadence stat falls back to the meter the same way.
- Flush: `finish-ride` accepts `samples.power` (zod in
  `lib/liveRecordingRideBody.ts`, defaulted to `[]` for older clients).
  `finishLiveRecordingRide` writes `rides.power_source = 'device'` (avg/max/
  kJ from `computePowerSummary`, over the active timeline like NP) and
  `ride_streams.watts_source = 'device'`, then computes NP/IF/TSS + the power
  curve best-effort (`services/ridePowerMetrics.ts`, see
  `.claude/rules/premium-parity.md` #8).
- Not verified against real hardware yet — no meter exists (tests use
  hand-built frames).

## Device provenance — `source_device` (MZY-271)

Every live-recorded sample is stamped with the BLE device that produced it
(`deviceId` = the transport's device id: Web Bluetooth `BluetoothDevice.id`,
opaque and stable per site, or the Bluetooth address in the Android app;
`deviceName`; `deviceKind` `heart_rate` | `csc` | `power` | `gps`) in
IndexedDB. GPS fixes carry the fixed stamp `PHONE_GPS_DEVICE`
(`phone-gps` / "Phone GPS" / `gps`, `lib/gps/source.ts`), so `ble_id` is
`phone-gps` for that entry.
Stamps are optional, so samples buffered before MZY-271 still flush (no
device).

- **Stored per point**: `run_streams`/`ride_streams.source_devices` (JSONB
  list, order of first use) + `<metric>_source_device SMALLINT[]`
  index-aligned with `time_s` (`heartrate_` on runs; `heartrate_`,
  `cadence_`, `velocity_`, `watts_` on rides), NULL where the metric has no
  value. Built by `lib/liveRecordingStreams.ts` `toRideStreamData`/
  `toRunStreamData` via `lib/sourceDevices.ts buildDeviceIndex`. CHECKs
  enforce alignment with `time_s`.
- **Primary rule** (`primaryDeviceFor`, applied at WRITE time in
  `cyclingSensorHub`): with two connected devices on one metric, only the
  primary's samples are recorded — the earliest-paired device still
  connected; a CSC cadence sensor outranks a power meter's crank cadence. A
  disconnect hands over to the next device (a switchover, visible as an
  index change in the array). No per-second gap-filling.
- **Alert**: `DeviceConflictAlert` on the record page lists every metric with
  more than one connected source — which device is recorded and which are
  ignored.
- **Imports stay NULL** (= unknown): Strava/TCX/Google Health name at most
  the activity's recording device, not which sensor produced each point.
- Ride/run detail show a "Sensors:" line from `source_devices`.

## BLE transport seam (MZY-275)

`app/record` never calls a Bluetooth API directly. Everything goes through
`BleTransport` (`lib/ble/transport.ts`: `requestDevice(service)` →
`{id, name}`, `connect(device, onDisconnected)`, `subscribe(device, service,
onFrame)` → unsubscribe, `disconnect`), picked by `lib/ble/index.ts
getBleTransport()`. Service keys map to Web Bluetooth names and 16-bit
assigned numbers in `lib/ble/gatt.ts`. The connection logic is plain TS,
unit-tested against a fake transport (`__tests__/record/fakeBleTransport.ts`):
`app/record/heartRateLink.ts` (HR strap state machine) and
`app/record/cyclingSensorHub.ts` (CSC + power, the primary rule). The page and
`useCyclingSensors` only hold React state. `onDisconnected` fires only for a
drop the app didn't request. `requestDevice` must be called synchronously from
the click handler (Chrome's user-gesture rule).

**Native transport (MZY-279).** Inside the Android shell `getBleTransport()`
returns `lib/ble/nativeBluetooth.ts` (`@capacitor-community/bluetooth-le`
8.3.0, MIT): `initialize({ androidNeverForLocation: true })` asks for Nearby
devices (only success is cached, so a denial is asked again), Bluetooth-off is
an explicit error, the plugin's native scan dialog replaces Chrome's chooser,
and services/characteristics go as 128-bit UUIDs (`uuid16To128`). Its string
rejections map to `BleCancelledError`/`BlePermissionError` (the HR card then
offers _Open settings_). **Device ids differ by transport**: native = the
Bluetooth address, web = an opaque per-site id, so one strap recorded in
Chrome and in the app appears under two `ble_id`s across recordings (always one
within a recording). Nothing compares `ble_id` across recordings, so no schema
change. The HRM 200 open-mode gotcha above applies unchanged.

## GPS capture (MZY-281) — Android app only

`lib/gps/` is the location seam, mirroring `lib/ble/`: `GpsSource.watch({
background }, onFix, onError)` → stop, picked by `getGpsSource()`. Inside the
shell it is `lib/gps/nativeGeolocation.ts`
(`@capacitor-community/background-geolocation` 1.2.26, MIT © James
Diacono). **The browser recorder stays GPS-less** (decided in MZY-281): a tab
is frozen with the screen off, so foreground Geolocation + Wake Lock would
give unreliable tracks.

- `app/record/gpsLink.ts` (plain TS, fake-source tests) runs a **warm-up**
  watcher (foreground, no notification) from page load so a fix is ready
  before Start, then on Start adds the **recording** watcher (background =
  the plugin's foreground service + "Agon is recording" notification)
  before removing the warm-up one. Duplicate fixes from the overlap are
  dropped as stale.
- `POST_NOTIFICATIONS` is requested by the in-repo `AgonNotifications`
  plugin (`android/.../NotificationPermissionPlugin.java`) before the
  recording watcher starts — the geolocation plugin declares it in its
  manifest but never asks, and without it the notification is hidden. Its
  manifest also brings FINE/COARSE location, `FOREGROUND_SERVICE(_LOCATION)`
  and the `location`-type service.
- **Accept filter** (`lib/gpsTrack.ts createGpsTrack`, applied at WRITE
  time, so `gps_samples` holds only the stored track): drop accuracy > 30 m,
  simulated fixes, fixes before Start or not newer than the last one, and a
  jump > 30 m/s from the last accepted fix; after 3 jumps in a row the old
  position was the outlier and the track re-anchors.
- **Distance** (`createDistanceCounter`): advances only when the fix isn't
  standing still (Doppler speed ≥ 0.5 m/s when reported) and is ≥ max(its
  accuracy, 5 m) from the last counted fix, then by the full distance — no
  phantom km while standing, straight lines keep their length.
  `cumulativeDistancesM` recounts a stored track identically.
- Live readout: run → pace + km, ride → km (GPS) next to sensor speed.
  Start is enabled by a GPS fix alone (no strap needed).
- Screen-off: fixes keep arriving under the foreground service, but the
  hidden-page pause below still holds IndexedDB writes in memory; the
  native journal (MZY-294, below) keeps them across a process death.

**Flush (MZY-282).** Both finish bodies carry `gps` (zod
`lib/gpsSampleSchema.ts`, defaulted to `[]` for older clients) and an
optional `distanceKm`. A run needs HR samples **or** a GPS track (GPS-only
runs have no strap).

- **Distance precedence** (`resolveDistanceKm`): typed > GPS track
  (`cumulativeDistancesM`, recounted exactly as the live readout) > wheel
  (rides). Nothing > 0 at 3 dp → `MissingDistanceError` → 400, the
  recording stays unflushed and the Save list asks for a distance. The list
  previews the derived value as the input's placeholder ("4.21 km (GPS)").
- **Streams** (`lib/liveRecordingStreams.ts`): runs now use the same 1 s
  axis as rides (`alignment`; this also removed duplicate `time_s` values
  from the HRM's ~2 Hz native notifications). GPS adds `lat`/`lng` (7 dp),
  `altitude_m` (1 dp, omitted when the phone gave none), `distance_m`
  (cumulative, 1 dp, forward-filled after the first fix, null before it) —
  all `NUMERIC[]`. Velocity: run = the fixes' Doppler speed; ride = the
  wheel sensor if it reported at all, else GPS for the whole ride, with
  `velocity_source_device` pointing at the phone.
- No `lat`/`lng` `_source_device` arrays: one phone GPS per recording, named
  in `source_devices` (kind `gps`). No migration was needed.
- `start_lat`/`start_lng` = the first accepted fix, so weather (MZY-226) and
  missed-stop detection (MZY-254) use the real start.
  A ride without a speed sensor gets avg/max speed from the GPS speeds.
- **Elevation gain (MZY-295)**: `lib/elevationGain.ts`, run over the
  stored `distance_m` + `altitude_m` (so flush and backfill agree). A port
  of gpx.studio's `_elevationComputation` (MIT, notice kept in the file):
  RDP ε 20 m on the (distance, elevation) curve, a 100 m distance-window
  average per segment, then the rises summed through a **0.5 m** hysteresis
  band. The band was picked on 86 Strava runs/rides with an upstream gain
  (`pnpm elevation:backfill` re-prints that calibration): no band +19 %
  median, 0.5 m −6 % with 50/81 runs within 15 %; the GoldenCheetah/
  OpenTracks 3 m is meant for raw altitude and halves gain here (−52 %).
  Caveat: Strava's stored altitude is already DEM/barometer-clean — phone
  GPS altitude is noisier, and on flat Berlin routes (median gain 16 m)
  synthetic phone-like noise still overcounts. The real-phone check is the
  MZY-295 done-when (live run vs its Strava/Google Health twin, ±15 %).
  Null with < 2 usable points.
- **Upstream gain wins**: when a live recording absorbs a twin
  (`mergeRunInto`/`mergeRideInto`), the twin's `elevation_gain_m` replaces
  ours (the other shared fields keep the winner's). `pnpm
elevation:backfill` (dry run; `--write`; seedGuard) fills only NULL gains.

## Android shell (MZY-272)

The recorder is moving into a Capacitor Android shell so it survives screen-off
(a browser tab/PWA gets frozen). Shell + signing: `capacitor.config.ts`,
`lib/androidShell.ts`, `lib/platform.ts` (`isNativeApp()`, the one runtime
check), `docs/self-hosting/android-app.md`. Spike findings (MZY-273) that
constrain the recorder code:

- **Secure origin only.** Plain-HTTP origins have no `crypto.randomUUID`, so
  `createRecording` throws.
- **WebView has no Web Bluetooth**, so native BLE is needed (MZY-279).
- **Hidden-page pause.** About 1 min after screen-off, the WebView's timers
  stop and IndexedDB writes queue in memory until the screen is back.
  Plugin callbacks still run. A process death in between loses the queue, so
  durability needs native-side buffering (MZY-294, below), and nothing on
  the recording path may rely on `setInterval`/`setTimeout`.

## Native sample journal (MZY-294)

Spike (MZY-294 comment): a call INTO a native plugin made from a plugin
callback still runs at once while the page is hidden — 2 calls/s held
through 3 min of screen off, no backlog at wake. So durability is an
in-repo plugin, not a native recorder:

- `SampleJournalPlugin.java` (`AgonJournal`): `append` writes one JSON line
  `{"s": store, "d": record}` to `files/recording-journal/<recordingId>.jsonl`
  (no fsync — a force-stop keeps the page cache); `read` in 512 KB chunks
  of whole lines; `clear`; `list`.
- `lib/liveRecordingDb.ts` journals in every `append*`, `createRecording`
  and `stopRecording` **synchronously before its first await** — the bridge
  call must leave while the sample callback runs. Web/PWA: a no-op.
- `replayJournals()` puts back what IndexedDB is missing (dedupe by store,
  `tMs`, `deviceId`; pure logic in `lib/sampleJournal.ts`): on Record page
  load (skipping the live recording) and before each flush. The journal is
  cleared by `markFlushed`/`discardRecording`.
- A recording that was never stopped (killed app) is finalized with its
  last sample's time as `endedAt`, not the time it was saved.
- Not here: resuming the recording after a kill (the run ends at the kill;
  OpenTracks-style `START_STICKY` resume would be a native recorder).

## Still open

A genuine local-first, multi-device, edit-anywhere architecture for the
whole PWA (modeled on Actual Budget) — see Linear (MZY-28) for the full scope
and open design questions. The screen-off wake lock and battery exemption
(MZY-280), barometric elevation gain and multi-device sync are still open.
