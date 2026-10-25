---
paths:
  - "services/googleHealth/**"
  - "services/strava/**"
  - "services/fitbit/**"
  - "services/fileImport/**"
  - "lib/gear.ts"
  - "lib/manualRide.ts"
  - "scripts/add-manual-ride.ts"
  - "lib/ridePower.ts"
  - "services/ridePower.ts"
  - "scripts/backfill-ride-power.ts"
  - "migrations/20261004000000_ride_power.sql"
  - "migrations/20260724*.sql"
---

# Run/Wellness Ingestion — Sources, Identity, Dedupe

Full build narrative (the Strava paywall pivot, Google Health migration
findings, live-verification results): tracked in Linear. This file is the
current-state design reference.

## Sources (see CLAUDE.md's Data Sources table for the full matrix)

- **Google Health API** (cloud REST, Google OAuth2) is the PRIMARY live run
  + wellness source. Runs recorded on Fitbit Air (no onboard GPS) + phone
  connected-GPS. `exercise` dataPoints carry only aggregate `metricsSummary`
  — route/speed/HR samples come from the per-session `:exportExerciseTcx`
  endpoint, parsed by a pure TCX parser (`services/googleHealth/streams.ts`,
  reused by the file importer). Resting HR/HRV/sleep/steps/distance/calories
  land via `services/googleHealth/wellness.ts` (`pnpm gh:wellness`), a
  date-range backfill separate from the per-run `gh:sync`. Its `body` pass
  (MZY-216, `services/googleHealth/bodyMap.ts`) upserts weight/body-fat into
  `body_metrics` on `(source, external_id)`, collapsing Health Connect
  mirrors (same local day + value → earliest kept).
- **Strava** is a live source only while Premium API access is enabled
  (the API needs a paid sub since 2026-06-30); when on, `pnpm strava:sync`
  outranks Google Health (see Source priority below). Its historical backfill
  data stays in Postgres. Legacy one-time enrichment
  (`pnpm strava:enrich` — matches Strava activities to existing
  `google_health` runs by time overlap and COALESCE-fills GPS/elevation/max
  HR + attaches a richer stream, never inserting duplicate rows).
  `pnpm strava:times` (MZY-40) stores Strava's paywall-only
  `moving_time`/`elapsed_time` per activity in `strava_activity_times`.
- **Generic GPX/TCX file importer** (`services/fileImport/`,
  `pnpm import:run`) is the free, ungated fallback for Samsung Health/Garmin
  (no live server API for either) and any other export. FIT (binary) is
  rejected with a re-export hint — native decode is backlogged.
- **Fitbit legacy Web API** (`services/fitbit/`) is deprecated — migrated
  onto the Google Health client before its Sept 2026 sunset. Kept for
  reference only.

## Source-agnostic identity — the load-bearing convention

Every adapter upserts through the SAME `upsertRun`, keyed on `(source,
external_id)` — this superseded the old Strava-specific
`strava_activity_id` key so Google Health, file imports, and any future
source share one idempotency mechanism. NULL `external_id` (manual runs)
never collides since NULLs are distinct in the unique index. `run_streams`'
PK is `run_id + source`, so one run can hold several sensors' series (e.g.
a GPS-carrying Strava stream alongside an HR-only Fitbit stream).
`runs.origin` records the upstream platform (Google Health's
`dataSource.platform`) for dedupe ranking — NOT used as a precision signal
on its own (see the "Excluding Google-Health-only runs" write-up in
Linear for why that distinction matters).

## Source priority across sources (MZY-225)

When the same run/ride arrives from several sources, ONE row is canonical,
by an athlete-decided ranking (`lib/activitySourcePriority.ts`, pure):
**(1) Agon** (`live_recording`, `manual`, `telegram`) > **(2) Strava**
(while Premium API access is on) or file exports (`strava_export`,
`garmin_export`, `samsung_export`, `polar`) > **(3) Google Health**. Every
ingest path (Strava runs+rides, Google Health runs+rides, file import, live
recording) calls `classifyIncomingActivity` (`services/activitySources.ts`)
before writing:

- An overlapping (60 s slack) stored twin of **equal or higher** priority →
  the incoming record is skipped (first stored wins within a tier). A skipped
  Strava record still attaches its stream to the winner when it has none;
  file import can `--force` through.
- A **lower**-priority twin starting within 5 min → the incoming record is
  written, then the twin is merged into it (`supersedeActivities`): its
  streams (where the winner lacks that source), gear, fueling items, sweat
  observations, and Strava activity times move over; notes append; HR,
  weather, and GPS start fill gaps only. Then the twin is deleted. Derived
  rows cascade away, so re-run `be:`/`re:`/`fueling:`/`tl:`/`rp:backfill
  --write`.
- A lower-priority overlap starting **>5 min** apart is logged and left
  alone. It's never deleted on a loose match.
- Start times in that match are the source's own:
  `COALESCE(source_started_at, started_at)`. A PWA "missed start"
  correction (MZY-253) moves `started_at` earlier and stashes the original
  in `source_started_at`. That column is also the time origin of the
  activity's stored streams.

## Hand corrections (MZY-252 / MZY-253)

Hand edits to source-owned columns go through `correctRun`/`correctRide`
(`services/activityCorrections.ts`), never a plain UPDATE. They land in
`corrected_fields`, which the shared upserts keep on re-sync. The PWA flow
(`PATCH /api/{runs,rides}/:id` → `services/activityCorrectionFlow.ts`;
math in `lib/activityCorrection.ts`) also cuts streams on a late-stop trim,
writes provenance (`general_notes` + a `qualitative_logs` row with
`source: 'manual_correction'`), and re-derives relative effort, best
efforts, fueling balance, training load and weather
(`services/activityDerived.ts`).

## Logging a ride by hand (`pnpm ride:add`)

The standard path for a ride no source captured, e.g. Strava never started,
or the only upload came from a device Strava sync ignores on purpose
(`STRAVA_IGNORED_DEVICES`, default `Garmin Speed Sensor` — GPS-less, no
auto-pause). Never a raw INSERT. `scripts/add-manual-ride.ts` (pure half:
`lib/manualRide.ts`, unit-tested):

```
pnpm ride:add --date=2026-10-03 --start=21:09 --km=6.97 --duration=24:00 \
  --avg-hr=127 --hr-estimated --strap --notes="Forgot to record on Strava."
# prints the row (dry run); add --write to persist
```

- `--start` is athlete-local (`profile.timeZone`). `--duration` takes
  `mm:ss`, `h:mm:ss` or seconds. Optional: `--max-hr`, `--elevation`,
  `--rpe`, `--bike` (gear name/id; default = bike on the latest ride).
- `--hr-estimated` marks a guessed avg HR in `general_notes`. Relative
  Effort still scores it (`method='average'`), so the note is the only
  thing telling an estimate apart from a measured average.
  `--strap` links the HRM worn on that date (`hrmForDate`).
- Identity: `source='manual'`, `external_id = manual-<date>-<HHMM>`, so
  re-running with corrected numbers updates the same row (notes/RPE are
  overwritten; they're ours, not a source's).
- Refuses when any ride already overlaps the interval (it was synced after
  all — correct that row via `PATCH /api/rides/:id` instead) unless
  `--force`. `manual` is top priority, so a later Strava/Google Health twin
  is skipped by its sync, not duplicated.
- After `--write`: gear links, then `recomputeDerivedForActivity` (weather at
  the home location — no GPS — Relative Effort, fueling balance, training
  load). No streams. `--avg-power`/`--max-power`/`--kj` store hand-read
  power with `power_source='manual'` (never fed into NP/TSS).

## Ride power: provenance first (MZY-267)

Every watt is stored with where it came from. Only `device` power may ever
feed NP/IF/TSS, FTP or power curves. Estimated and manual power is shown,
labelled, and never computed on.

- `rides.avg_power_w`/`max_power_w`/`weighted_avg_power_w`/`kilojoules`
  plus `power_source` (`device` | `estimated` | `manual`, NULL = none). A
  CHECK rejects watts without a source. `weighted_avg_power_w` is the
  source's own NP-like figure, never Agon's NP.
- `ride_streams.watts` + `watts_source` (`device` | `estimated`). Provenance
  is per stream row, since one ride can hold an estimated and a measured
  series. `upsertRideStreams` throws on unlabelled watts.
- **Strava**: the summary `average_watts`/`kilojoules` are filled even with
  no meter (Strava's model); `device_watts` says which (`powerFields`,
  `services/strava/mapper.ts`). `weighted_average_watts`/`max_watts` are
  meter-only. The `watts` stream is requested, but on 2026-10-04 Strava
  returned **no** watts stream for any of the 5 estimated rides. Without a
  meter there is no power series, only summary avg W + kJ.
- **TCX** (`<Watts>` TPX extension) is parsed by both TCX parsers as
  `device` power (TCX has no power model). The file importer still writes
  runs only (rides: MZY-268).
- **Corrections**: the five power columns are one group. `correctRide`
  labels a hand-edited watt value `manual`. If any power column is in
  `corrected_fields`, a re-sync keeps all five (otherwise a Strava estimate
  could land beside a hand value under the `manual` label).
- **Backfill**: `pnpm power:backfill-rides` (dry run; `--write`;
  `--probe-streams` also fetches streams for meter-less rides). It re-reads
  summary watts from the paged activity list (cheap) and fetches streams only
  for `device_watts` rides. It writes only the power columns and watts series
  (`services/ridePower.ts`), skips a stream whose sample count no longer
  matches (hand-trimmed), stops cleanly on a rate limit, and re-runs
  `recomputeDerivedForActivity` for each written ride.
- **Device provenance** (MZY-271): `run_streams`/`ride_streams.source_devices`
  + `<metric>_source_device` are live-recording only; every import path
  leaves them NULL. See `.claude/rules/live-recording.md`.
- **Derived metrics** (MZY-269): NP/IF/TSS + power curve come only from
  `watts_source='device'` rows — `pnpm power:backfill-metrics` and the
  `power_metrics` derived step. See `.claude/rules/premium-parity.md` #8.

## Missed-stop suggestions (MZY-254)

Every sync entry point ends with `postSyncMissedStops()`: the sync scripts,
Telegram `/sync`, both live-recording finish routes and `import:run`. It is
best-effort like the weather pass and never fails a sync.
`lib/missedStopDetection.ts` looks for a slow tail at the end of the GPS
stream of runs/rides from the last 30 days:

- The tail sits inside 100 m of home (`homeLocationOrNull()`), or else inside
  50 m of the final point (confidence "away").
- It lasts ≥ 60 s at ≤ 0.8 m/s mean, and covers ≥ 10 m or has ≥ 10 s moving.
- The "stopped" speed that places the cut is 1 m/s for runs and 2.5 m/s for
  rides (walking the bike in counts as part of the tail).

Hits are stored in `missed_stop_suggestions` (one row per activity) and
never applied automatically. Activities with a hand-made late-stop trim
are skipped. Applying a suggestion goes through the MZY-253 late-stop
correction. Open suggestions are listed on the dashboard (`GET
/api/missed-stops`, `components/OpenStopSuggestions.tsx`) as well as on the
activity page, and `notifyOpenSuggestions` logs a warning when
`TELEGRAM_OWNER_CHAT_ID`/`TELEGRAM_BOT_TOKEN` are missing instead of
skipping silently. Backtest with `pnpm stops:backtest [--list]`; on 2026-09-30
it flagged 0 of 78 runs and 1 of 3 rides (ride 2, already hand-trimmed).

Consequence: `strava:enrich` (in-place enrichment of `google_health` rows)
is superseded by plain `strava:sync`/`strava:backfill`, which now replace
the Google Health row outright.

## Dedupe within Google Health (`services/googleHealth/dedupe.ts`, pure + unit-tested)

Google Health is NOT a clean single source of truth: the same run often
appears as both a `health_connect` record (phone app/Samsung/Strava via
Android Health Connect — trustworthy) and a `fitbit` record (the Fitbit
Air's own passive auto-detection — drifting duration, usually no HR). The
ingest collects a whole batch, groups records by overlapping time interval
(60s slack), and keeps ONE canonical per real run, ranked `health_connect`
> `actively_measured` > longest distance. The cross-source rule above then
applies: Google Health is the lowest tier, so any stored twin blocks it.

## Watermark-based incremental sync

The "since" cursor is derived from the DB (`max(runs.started_at) WHERE
source=X`), never a separate cursor table — one source of truth, can't
drift from the data. Applied CLIENT-SIDE for Google Health specifically:
the `exercise` dataType has no server-side start-time filter that works (every
variant tried returns `INVALID_DATA_POINT_FILTER`), so the ingest lists
sessions unfiltered and drops those at/before the watermark in code.

## Fitbit-wrist granular HR

Per-second HR pulled from Google Health's `heart-rate` measurement dataType
into `run_streams` **source `fitbit`** (kept distinct from a chest-strap
SOT), and avg/max only FILL a run's HR where none exists (`updateRunHr`
COALESCE — a chest-strap avg is never overwritten). Measurement dataTypes
require the FULLY-QUALIFIED filter path
`heart_rate.sample_time.physical_time >= X AND < Y` (a bare `start_time`
400s).

## OAuth scopes (Google Health)

`googlehealth.{activity_and_fitness,location,health_metrics_and_measurements}.readonly`
— the GPS route needs the separate `location` scope; HR needs
`health_metrics_and_measurements`. No Garmin integration exists or is
planned via a live API — Garmin's Connect API is partner-gated
(individual sign-ups closed).

## References

- Strava API v3: https://developers.strava.com/docs/reference/
- Google Health API: https://developers.google.com/health/about
- Google Health API data types (ExerciseSession/ExerciseRoute/Speed/
  Distance/HeartRate): https://developers.google.com/health/data-types
- Fitbit Web API → Google Health transition:
  https://community.fitbit.com/t5/Web-API-Development/Introducing-the-next-phase-of-the-Fitbit-Web-API/td-p/5821061
- Samsung Health via Health Connect (on-device SDK, no REST API):
  https://developer.samsung.com/health/blog/en/accessing-samsung-health-data-through-health-connect
- Garmin Connect Developer Program (partner-approval-gated):
  https://developer.garmin.com/gc-developer-program/health-api/
