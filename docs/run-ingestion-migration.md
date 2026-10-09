# Run Ingestion Migration — off Strava, onto free sources

**Decision date:** 2026-07-24 · **Status:** Workstream A built (awaiting live
credential verification) · **Owner:** single athlete

## Progress (2026-08-05) — incremental-sync fix + Strava-premium enrichment

- [x] **Incremental `gh:sync` was broken; fixed with a client-side watermark.**
  The exercise dataType exposes **no comparable start-time member**: probed live,
  `start_time > "…"`, `exercise.interval.start_time`, `civil_start_time`,
  `start_time.physical_time` all return `INVALID_DATA_POINT_FILTER`. The "97 runs
  verified live" pull worked only because a first sync (empty DB → null watermark)
  sends **no filter**; the incremental path was never exercised until the first
  `/sync` against a non-empty DB. Fix: `listExerciseSessionsPage` now lists
  **unfiltered** and `ingest.ts` drops sessions at/before the watermark **in code**
  (~100 sessions / 1–2 pages, cheap). Corrects the §4 / line-349 claim that
  sessions filter on bare `start_time`.
- [x] **Cross-source overlap guard.** `overlappingRunExists` broadened from
  `source='google_health'` to **any source**, so a later `gh:sync` won't insert a
  `google_health` twin of a run stored from Strava.
- [x] **Strava-premium one-time enrichment.** A gifted premium month reopened
  Strava API access (paywall is per-developer-subscription). `pnpm strava:enrich`
  (`services/strava/matchEnrich.ts` + `scripts/enrich-runs-from-strava.ts`):
  match each Strava activity to the existing `google_health` run by time overlap
  (start-delta bound + distance-confidence gate), COALESCE-fill GPS/elevation/max-HR,
  and attach HR/pace/altitude/cadence **+ GPS route track** as a `source='strava'`
  `run_streams` row. `--insert-unmatched` adds Strava-only runs (skips split/merge
  overlaps); `--refresh-streams` backfills the track. **49 runs gained GPS + weather
  + full route tracks.** NOT a return to Strava as a live source.
- [x] **GPS route track in `run_streams`.** Migration
  `20260805000000_run_streams_gps_track.sql` adds nullable `lat[]`/`lng[]`
  (index-aligned with `time_s`); Strava streams fetch now requests `latlng` and
  splits the pairs. Enables map rendering + planned-vs-actual GPS comparison.

## Progress (2026-07-24)

- [x] **A1 — identity migration.** `20260724010000_run_identity_and_google_health.sql`:
  nullable `runs.external_id` + unique index on `(source, external_id)`, backfilled
  existing Strava rows, widened the `runs`/`run_streams` source CHECKs to admit
  `google_health`. `RunRecord.external_id` added; the shared `upsertRun` now
  conflict-targets `(source, external_id)`. Expand phase only — `strava_activity_id`
  UNIQUE is kept for a later contract migration.
- [x] **A2/A3 — Google Health adapter.** `services/googleHealth/`
  (oauth/types/client/mapper/streams/ingest/sync/index) mirroring `services/strava/`.
  Token table `20260724011000_google_health_ingestion.sql`. Scripts `pnpm gh:auth`
  + `pnpm gh:sync`. Env `GOOGLE_HEALTH_CLIENT_ID/SECRET/REDIRECT_URI`. Unit lane
  mocks `fetch` (oauth/client/mapper/streams/sync); DB write paths in the
  integration lane (`__tests__/integration/googleHealthSync.test.ts`).
- [x] **A4 — Telegram `/sync` repointed** from `syncNewStravaRuns` to
  `syncNewGoogleHealthRuns` via the (renamed, source-neutral) `syncRuns` ctx seam.
- [x] **Live verification — DONE 2026-07-24.** Authorized against the athlete's
  real account and pulled **97 runs** (188 sessions seen, 91 non-runs skipped, 8
  pages) into `runs` (source `google_health`). Findings folded back into the code
  (see the resolved §8 below):
  - **Scopes** use the `googlehealth.` prefix + `.readonly` suffix (an initial
    guess of `health.activity_and_fitness` failed `invalid_scope`). The run
    pipeline requests three: `activity_and_fitness` (sessions), **`location`**
    (route/GPS — it IS a separate scope, resolving §8's top question), and
    `health_metrics_and_measurements` (per-sample HR).
  - **`exportExerciseTcx` returns JSON** `{ "tcxData": "<xml>" }`, not raw XML —
    the client now unwraps it.
  - **`metricsSummary` is sparser than documented:** it has `distanceMillimeters`,
    `averageHeartRateBeatsPerMinute` (int64-as-string), `averagePaceSecondsPerMeter`,
    `caloriesKcal`, `steps`, and a bonus `heartRateZoneDurations` — but **no
    `elevationGainMillimeters` and no max-HR** for these Fitbit-Air runs, so those
    columns stay null. `exerciseType` is a bare `"RUNNING"` (the substring match
    holds). `exerciseMetadata` came back `{}` (no `hasGps`), so the ingest now
    always attempts the TCX when `--streams` rather than gating on that flag.
  - **Connected-GPS reality confirmed (§8):** the Fitbit Air has no GPS chip, so a
    run only has a route/track when the phone recorded one. The runs sampled had
    **no `<Trackpoint>`s** (route-less) → no `run_streams`, `start_lat/lng` null,
    weather-per-GPS won't fire — exactly the documented degradation. The TCX
    parser is correct; there was simply no track data to parse for these runs.
- [x] **SOT-quality dedupe + Fitbit HR (2026-07-24, verified live vs the SOT sheet).**
  Diffing the pulled runs against the athlete's "Event Logging" cardio sheet
  showed Google Health holds each run up to twice — a `health_connect` record
  (phone/Samsung/Strava via Android Health Connect, matches the SOT to the metre)
  and a `fitbit` auto-detect twin (drifting duration, no HR). Resolved:
  - `runs.origin` (migration `20260724012000`) records the upstream platform.
  - `services/googleHealth/dedupe.ts` collapses overlapping records to one
    canonical run (rank: health_connect > actively_measured > longest distance).
    Live: 97 → 83 canonical (81 health_connect + 2 fitbit-only), SOT distances
    matched (69/72 within 50 m).
  - `services/googleHealth/heartRate.ts` attaches granular Fitbit wrist HR from the
    `heart-rate` dataType into `run_streams` source `fitbit`, filling avg/max HR
    only where the SOT record had none. Filter grammar for measurement types is
    the fully-qualified `heart_rate.sample_time.physical_time >= X AND < Y`.
  - **Garmin:** no free live API (Connect is partner-gated, individual sign-ups
    closed 2026); chest-strap HR would come via the Workstream-B FIT importer.
    Fitbit wrist HR from Google Health fills the granular-HR need without it.
- [x] **B — generic GPX/TCX file importer (2026-07-24, app-side; live file
  verification pending).** `services/fileImport/` + `pnpm import:run`. In-repo
  pure parsers → shared summary math → shared `upsertRun` (source per file), with
  a deterministic file-hash `external_id` and a cross-source time-overlap guard so
  a run already pulled via Google Health isn't duplicated. FIT is rejected with a
  re-export hint (native FIT decode deferred). 34 unit tests. Full write-up in §5.
- [x] **C — Fitbit→Google Health wellness migration (2026-07-24) — built + live
  verified (activity + HRV; sleep pending re-consent).** The four Fitbit passes move onto the same Google Health
  OAuth client + token row the run adapter uses, ahead of the Sept 2026 Fitbit Web
  API sunset. **Run HR was already migrated** as part of Workstream A
  (`heartRate.ts` attaches Fitbit-wrist HR to each `google_health` run); this
  covers the remaining three: all-day activity + resting HR → `daily_activity`,
  sleep → `sleep_sessions`, HRV → `hrv_daily`. `services/googleHealth/wellness.ts`
  (orchestrator, DI seams) + `wellnessMap.ts` (pure mappers/assembly/filters);
  `client.listDataPointsPage` is the generic dataType lister. Entry point
  `pnpm gh:wellness --since=… [--until=…] [--only=activity,sleep,hrv]` (mirrors
  `fitbit:backfill`; separate from the per-run `gh:sync`). Migration
  `20260724014000_google_health_wellness.sql` **applied + verified** (source CHECKs
  widened; `sleep_sessions.external_id` + unique index; Fitbit backfill); integration
  lane green against local Postgres. `services/fitbit/` kept but deprecated. **A live
  pull against the real account folded major API corrections back into the code** —
  see the "Live verification" subsection in §6. 22 unit tests (mock fetch).

---

**Original plan below (2026-07-24).**

**Decision date:** 2026-07-24 · **Status:** planned (no code yet) · **Owner:** single athlete

This plan implements the **Run Ingestion Pivot** recorded in `CLAUDE.md`. It
replaces Strava's now-paywalled live API with free, un-gated sources while
keeping the `runs` / `run_streams` schema and the historical Strava backfill
data untouched.

---

## 1. Why (the trigger)

- **Strava API now costs money.** As of **2026-06-30**, Standard-tier Strava API
  access requires an active **Strava subscription (~$11.99/mo)** — per developer,
  not per app. The exempt Extended tier is gated to large partners. Paying it
  defeats Agon's whole reason for existing.
  Ref: <https://appsforstrava.com/blog/strava-developer-program-changes-2026/>
- **A latent Fitbit deadline compounds it.** The legacy **Fitbit Web API** that
  `services/fitbit/` uses today **sunsets September 2026**; it is replaced by the
  **Google Health API** (Google OAuth2, tokens do NOT transfer, users re-consent).
  Ref: <https://community.fitbit.com/t5/Web-API-Development/Introducing-the-next-phase-of-the-Fitbit-Web-API/td-p/5821061>

Building the run pipeline on Google Health now kills two birds: a free forward
run source **and** the Fitbit migration land on one client.

---

## 2. What stays (do not touch)

- **Historical Strava data in Postgres** — the Mar–Jun 2026 backfill (runs +
  `run_streams`, `source='strava'`) was a one-time free-tier pull. It stays.
- **The schema** — already source-agnostic: `runs.source` + `run_streams` PK is
  `(run_id, source)`. New sources slot in with no migration to the run tables.
- **`services/strava/` code** — kept, marked deprecated. `strava:sync` /
  `strava:backfill` still run for anyone who has Strava access; they're just not
  the forward path. The DB-derived-watermark design in `strava/sync.ts` is the
  template the Google Health sync copies.

---

## 3. Source strategy (free + actually reachable)

| Source | Fee | Reachable from our Node/VPS backend? | Role |
|---|---|---|---|
| **Google Health API** | Free | ✅ Cloud REST, Google OAuth2 | **Primary live** |
| Manual GPX/FIT/TCX export | Free | ✅ File on disk | **Universal fallback** |
| Samsung Health | Free | ❌ On-device Android SDK only, no REST | fallback via file export |
| Garmin Connect API | Free | ❌ Partner-approval-gated; individual sign-ups closed 2026 | fallback via file export |
| Strava API (live) | **Paid** | ✅ but costs a sub | retired |

Verified 2026-07-24 that the Google Health API exposes, server-side, everything a
`runs` row + `run_streams` series needs: `ExerciseSession` with `ExerciseRoute`
(lat/lng/altitude), `SpeedRecord`, `DistanceRecord`, `HeartRateRecord` (route also
available as TCX).
Refs: <https://developers.google.com/health/data-types> ·
<https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints>

---

## 4. Workstream A — Google Health API run adapter (primary)

New module `services/googleHealth/`, mirroring `services/strava/` +
`services/fitbit/` conventions (typed client, zod at every boundary, OAuth token
lifecycle module, pure mapper, orchestrating ingest, `index.ts` surface).

**Files (proposed):**
- `oauth.ts` — Google OAuth2 authorization-code + refresh flow; token storage
  matching the Fitbit/Strava token pattern. Env: `GOOGLE_HEALTH_CLIENT_ID`,
  `GOOGLE_HEALTH_CLIENT_SECRET`, redirect URI. Scopes: activity/fitness +
  whatever gates `ExerciseRoute` (see open questions).
- `types.ts` — zod schemas for `ExerciseSession`, `ExerciseRoute`,
  `SpeedRecord`, `DistanceRecord`, `HeartRateRecord`, and the
  `users.dataTypes.dataPoints` list/get envelopes.
- `client.ts` — thin typed GET/list client (`fetch` stubbed in tests), with a
  `GoogleHealthRateLimitError` analogous to `StravaRateLimitError`.
- `mapper.ts` — pure `ExerciseSession → RunRecord` (source `google_health`),
  reusing `computeBlockWeek`, pace derivation, gps/lat-lng handling. Filter to
  running sessions with positive distance + duration (mirror `isIngestableRun`).
- `streams.ts` — assemble the aligned `run_streams` arrays from the route +
  speed + HR samples (reuse `RunStreamData` shape; index-align on time).
- `ingest.ts` — orchestrator: list sessions, upsert runs (reuse `upsertRun` —
  it's keyed on `strava_activity_id`, so **add a generic external-id column**;
  see migration note below), pull streams, link gear/HRM.
- `sync.ts` — **reuse the watermark idea verbatim**: `since` =
  `max(runs.started_at) WHERE source='google_health'`; incremental, idempotent,
  rate-limit-aware.
- Script `scripts/sync-google-health.ts` (`pnpm gh:sync`) + auth script
  (`pnpm gh:auth`).

**Migration needed (one, small):** `upsertRun` currently conflicts on
`strava_activity_id`. Generalize to a `(source, external_id)` identity so
non-Strava sources upsert idempotently. Expand→contract:
1. Add nullable `runs.external_id` + unique index on `(source, external_id)`.
2. Backfill `external_id = strava_activity_id::text` for existing strava rows.
3. Point new upserts at `(source, external_id)`; keep `strava_activity_id` for
   now (contract later once nothing reads it).
Single timestamped file under `migrations/`, applied with `pnpm migrate`.

**Then:** repoint Telegram `/sync` from `syncNewStravaRuns` to the Google Health
sync (same injectable-deps seam, so the handler stays transport-thin and the unit
test just swaps the stub).

**Tests:** unit lane mocks `fetch` (mapper + client + watermark derivation, no
DB/network); DB write paths in the integration lane. Same split as Strava.

---

## 5. Workstream B — generic run-file importer (fallback)

`scripts/import-run-file.ts` (`pnpm import:run <file> [--source=…]`): parse a
GPX / FIT / TCX file into the same `RunRecord` + `RunStreamData` shapes and upsert
via the shared path. `source` set per file (`samsung_export`, `garmin_export`,
`strava_export`); `external_id` = a deterministic hash of file identity so
re-import is idempotent. This is the true portability floor — no vendor can gate
it. Parser libs: evaluate a maintained GPX/FIT/TCX parser (check licenses per the
Prior Art policy) vs. a small in-repo parser for the fields we use.

**Implemented 2026-07-24 (app-side; live file verification pending).** Built with
small in-repo parsers (no XML/parser dependency — mirrors the codebase's
regex-based Google Health TCX parser, avoiding the Prior-Art license review a lib
would need). Entry point `pnpm import:run <file...>`
(`--source`, `--no-streams`, `--force`).

- **`services/fileImport/`**: `gpx.ts` + `tcx.ts` are pure parsers →
  `ParsedActivity` (format-neutral `TrackPoint[]` + a declared summary +
  `creator`). `track.ts` holds the shared math: `alignPointsToStreams` (the
  generalized googleHealth streams builder — same "emit an array only when a
  field was measured" rule, but retaining absolute times + lat/lng so a
  distance-less GPX can be measured from its GPS track) and `resolveMetrics`
  (distance from cumulative `DistanceMeters` → haversine over the track → declared
  summary; duration, avg/max HR, noise-floored elevation gain). `build.ts` maps to
  a `RunRecord` (local date via `ATHLETE_UTC_OFFSET_HOURS`, `origin` null) and
  computes the `external_id` (`file:<sha1-16>` of start+distance+duration).
  `import.ts` is the orchestrator (DI seams for the DB writes → unit-testable with
  no Postgres).
- **Source inference**: from the file's `creator` (`StravaGPX` → `strava_export`,
  `Garmin…` → `garmin_export`, `Samsung/SHealth` → `samsung_export`); `--source`
  overrides. Unknown creator → a clear "pass --source" error.
- **Cross-source dedup guard** (the concern raised at build time): Google Health
  only signals the *platform layer* (`health_connect` vs `fitbit`), not the
  specific writing app, so a Samsung run flows in as `origin=health_connect` and
  its later Samsung *export* would be the same physical run under a different
  `source`. `findOverlappingRun` matches ANY existing run overlapping the
  candidate interval (±60 s) with a different `(source, external_id)` and skips
  the import (logged); `--force` imports anyway and surfaces the conflict. The
  googleHealth in-batch dedupe can't catch this — it's single-source.
- **Schema**: migration `20260724013000_run_file_import_sources.sql` (EXPAND-only)
  widens the `runs` + `run_streams` source CHECKs to admit the three `*_export`
  tags; `lib/constants.ts` gains `FILE_IMPORT_SOURCES` + `isFileImportSource`.
- **FIT** is detected (extension / `.FIT` signature) and rejected with a
  "re-export as TCX/GPX" hint — native binary FIT decode is deferred (it needs a
  parser dependency + a Prior-Art license review; chest-strap FIT files were
  always the eventual reason to add it).
- **Tests**: `__tests__/fileImport/` (34 unit tests) cover the parsers,
  alignment, metric resolution + fallbacks, `external_id` determinism, source
  inference, and the orchestrator's skip/force/no-streams/reject paths with fake
  deps. DB write paths (the real overlap query) remain for the integration lane.

---

## 6. Workstream C — Fitbit → Google Health migration (before Sept 2026)

Fold the existing Fitbit HR / steps / resting-HR / sleep / HRV pulls onto the same
Google Health OAuth client + token row (`google_health_oauth_tokens`) the run
adapter uses, so the Fitbit Web API sunset is a config+adapter change, not a
rebuild — and it's ONE migration, not two.

**Implemented 2026-07-24 (app-side; live verification pending).**

### Scope & dataType findings (docs-verified; `TODO(live)` where unconfirmed)

The central structural change: Fitbit returns ONE `activities/date/{date}.json`
summary bundling steps + floors + distance + active minutes + calories + resting
HR. Google Health has **no equivalent single summary** — each metric is its own
dataType, so a `daily_activity` row is ASSEMBLED by folding several pulls, bucketed
to the athlete-local day. The table below is the **post-live-verification** state
(2026-07-24); the "Live verification" subsection lower down records what changed
from the docs.

| Fitbit today | Google Health dataType | Kind | Scope | Status |
|---|---|---|---|---|
| intraday HR → `run_streams` | `heart-rate` | Sample | `health_metrics_and_measurements` | **built** (`heartRate.ts`, run adapter) |
| active minutes | **`active-zone-minutes`** | Interval | `activity_and_fitness` | **live-verified** (per-minute buckets, summed; zone-minutes ≠ Fitbit active-min) |
| resting HR | `daily-resting-heart-rate` | Daily | `health_metrics_and_measurements` | **live-verified** (`beatsPerMinute`) |
| HRV (+ deep) | `daily-heart-rate-variability` | Daily | `health_metrics_and_measurements` | **live-verified** — avg + deep RMSSD both map |
| sleep + stages | `sleep` | Session | **`sleep` ← NEW scope** | **blocked on re-consent** (403); shape `TODO(live)` |
| steps / distance | `steps` / `distance` | (rollup) | `activity_and_fitness` | **live-verified 2026-08-26** via `dailyRollUp` (List multi-source-overlaps; see §6a) |
| floors / calories | `floors` / `total-calories` | (rollup) | `activity_and_fitness` | `total-calories` **live-verified 2026-08-26**; `floors` wired but the athlete's device reports no floors data (untested against real values) |

- **Only ONE new OAuth scope:** `googlehealth.sleep.readonly`. Active-zone-minutes
  falls under `activity_and_fitness`, resting HR + HRV under
  `health_metrics_and_measurements` — both already granted for runs. Added to
  `scripts/google-health-auth.ts`; adding a scope forces a re-consent (which the
  whole migration requires anyway — Fitbit tokens don't transfer).
- **Run HR is already migrated** — the old Fitbit `run-hr` pass is functionally
  done inside the run adapter, so only activity/resting-HR, sleep, HRV remained.
- **Filter grammar (live-resolved):** the member path is the **snake_case dataType**
  (`daily_resting_heart_rate`, `active_zone_minutes`), matching the verified
  `heart_rate.sample_time.physical_time` grammar; daily types compare `<snake>.date`
  to a `YYYY-MM-DD`, interval types `<snake>.interval.start_time` to an instant.
  Details below.

### Code + schema

- **`services/googleHealth/wellnessMap.ts`** (pure): union-field resolution,
  defensive value reads (`readNumber` tries candidate field names + coerces
  int64-as-string → null on mismatch, never throws), local-day bucketing, the
  daily-activity accumulator (`ACTIVITY_METRICS` spec → `foldActivityPoints` →
  `accumulatorToRecords`), `mapSleepSession`, `mapDailyHrv`, and the filter
  builders. Split from the orchestrator to stay under the file-size budget.
- **`services/googleHealth/wellness.ts`** (orchestrator): `backfillGoogleHealthWellness`
  with DI seams (`getAccessToken` / `listDataPoints` / the three upserts) so it's
  unit-testable with no DB/network. Passes `activity` / `sleep` / `hrv`; idempotent
  upserts; stops cleanly on HTTP 429 (`rateLimited`) and resumes next run.
- **`services/googleHealth/client.ts`**: `listDataPointsPage` — one generic typed
  lister reused for every wellness dataType (envelope parsed strictly, per-type
  value passthrough).
- **Writers reused** (`upsertDailyActivity` / `upsertSleepSession` /
  `upsertHrvDaily`); only their `source` unions widen to add `google_health`.
- **Migration `20260724014000_google_health_wellness.sql`** (EXPAND-only): widens
  the `source` CHECK on `daily_activity` / `sleep_sessions` / `hrv_daily`, and gives
  sleep a source-agnostic identity — a Google sleep-session id is an opaque string,
  not the `BIGINT log_id` Fitbit hands out, so `sleep_sessions.external_id TEXT` +
  a unique `(source, external_id)` land (mirroring the runs A1 identity), Fitbit
  rows backfilled `external_id = log_id::text`. The Fitbit mapper now also sets
  `externalId = String(logId)` so every sleep row keys the same way; the upsert
  conflict target moves to `(source, external_id)`.
- **Entry point** `pnpm gh:wellness` (`scripts/backfill-google-health-wellness.ts`)
  — a date-range backfill mirroring `fitbit:backfill`, deliberately SEPARATE from
  the per-run watermark `gh:sync` (different cadence/shape; keeps Telegram `/sync`
  fast). A thin incremental wellness sync on `max(daily_activity.date)` is a later
  option.
- **`services/fitbit/` kept but deprecated** (same treatment as Strava) — a cutover
  fallback until the Google Health wellness pull is verified live; retire it (and
  `fitbit_oauth_tokens`) after.

### Rate-limit pacing (resolves the open Phase 2 item)

The "rate-limit-aware Fitbit backfill pacing (150 calls/hr)" item is **largely
moot** post-migration: it targeted Fitbit's 150-req/hr ceiling (why the Fitbit
backfill chunks into 30-day ranges). Google Health's quotas are far higher and it's
already covered by the `GoogleHealthRateLimitError` stop-and-resume the run adapter
built (reused here — a bounded page loop + `pageDelayMs` + `rateLimited` flag). Keep
a small page delay; close the Fitbit-specific pacing work as superseded once Fitbit
is retired.

### Live verification (2026-07-24 — against the athlete's real account)

A live read-only probe + a real `gh:wellness --only=activity,hrv` pull (6 days)
exposed several ways the v4 API diverges from the docs. All folded back into the
code:

- **Filter member path is snake_case, not the camelCase union field.** The response
  nests the value under a camelCase field (`dailyRestingHeartRate`), but the FILTER
  path is the snake_case dataType (`daily_resting_heart_rate`) — matching the
  verified `heart_rate.sample_time.physical_time` measurement grammar. camelCase 400s
  ("does not match any data type"). This is why single-word `steps`/`distance`
  filters passed but multi-word ones failed. Fixed in `snakeType()`.
- **Daily types filter on `<snake>.date >= "YYYY-MM-DD"`** (a local calendar date),
  and carry the day as a **structured `{ year, month, day }` object**, not an ISO
  string. Interval types filter on `<snake>.interval.start_time` (RFC-3339). ~~Sessions
  on bare `start_time`.~~ **CORRECTED 2026-08-05: exercise sessions have no
  server-filterable start-time member; the watermark is applied client-side (see the
  2026-08-05 progress entry at top).** Handled by `dailyRangeFilter` /
  `intervalRangeFilter` + `structuredDateToISO`.
- **`active-minutes` isn't the type — `active-zone-minutes` is** (per-HR-zone,
  per-minute rows, value `activeZoneMinutes`, in DISCRETE 1-minute buckets → safe to
  sum). Verified live: plausible daily totals (e.g. 164/93/155 min).
- **`daily-heart-rate-variability` DOES expose deep RMSSD** —
  `averageHeartRateVariabilityMilliseconds` (daily) +
  `deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds` (deep). Both now map;
  the earlier "deepRmssd → null" assumption was wrong.
- **`daily-resting-heart-rate` verified** (value `beatsPerMinute`, int64-as-string) —
  live 56–59 bpm, matching expectation.
- **steps / distance are NOT summable from List** and are OMITTED. List returns raw
  sub-minute samples from multiple OVERLAPPING sources (Fitbit passive + Health
  Connect), and even one source's intervals are overlapping rolling windows — a real
  day summed to ~102k "steps". `floors` / `total-calories` don't support List at all.
  All four need Google's `dailyRollup` action (the correct daily-total source).
- **`sleep` → 403**: the added `googlehealth.sleep.readonly` scope isn't on the
  existing token. Needs a `pnpm gh:auth` re-consent before the sleep pass can run or
  be verified; its stage/duration field names stay `TODO(live)` until then.

**Result:** `daily_activity` (active-zone-minutes + resting HR) and `hrv_daily`
(avg + deep RMSSD) verified writing correct values to Postgres.

### Residual follow-ups

1. **`sleep` pass** — `pnpm gh:auth` re-consent for the `sleep` scope, then verify the
   sleep-session payload shape (stage vocabulary + duration fields, currently
   best-effort `TODO(live)` in `mapSleepSession`).

Resolved 2026-08-26 — see §6a below: **`dailyRollUp` for steps / distance / floors /
calories**.

---

## 6a. `dailyRollUp` for steps / distance / floors / calories (resolved 2026-08-26)

Wired the `:dailyRollUp` custom method Google exposes for the four cumulative
daily-total metrics `List` can't give correctly (see §6's table). The earlier
`dataPoints:dailyRollup` URL 404'd for a trivial reason — **the method is
`dailyRollUp`, capital U** — but the REQUEST SHAPE also needed live pinning; the
documented (paraphrased) shape was wrong in two ways a live probe caught:

- **`CivilDateTime` request fields**: docs implied a flat
  `{year, month, day, utcOffsetSeconds}`. The real API 400s on that
  ("Unknown name 'year' at range.start"). The actual shape nests under a `date`
  sub-object with NO timezone/offset member at all —
  `{ date: { year, month, day } }` — because CivilDateTime is deliberately
  timezone-free ("ensures neither the timezone nor the UTC offset can be set, to
  avoid confusion between civil and physical time queries"). Day buckets are
  resolved server-side against the ACCOUNT's own registered civil timezone, not
  one the client sends — confirmed correct against the athlete's Berlin account
  (bucketed days matched the expected local calendar days).
- **`distance`'s response field**: docs said `metersSum`; the real field is
  **`millimetersSum`** (int64-as-string, same convention as `countSum`). A direct
  probe against the live API (`distance: { millimetersSum: "17902309" }` for a
  known long-run day) caught this before it shipped as a silent null.
- **`floors`** genuinely returns an empty rollup (`{}`, zero `rollupDataPoints`)
  for this athlete's account — the Fitbit Air likely has no barometric altimeter.
  Wired identically to the other three metrics; simply has no live values to
  verify against yet.
- **Range caps differ by dataType**: 90 days for steps/distance/floors, but only
  14 days for `total-calories` (shares Google's cap with
  calories-in-heart-rate-zone/heart-rate/active-minutes). A long backfill window
  is chunked per-metric (`chunkLocalDayRange`) before calling `dailyRollUp`.

**Code**: `dailyRollUp()` in `client.ts` (POST, mirrors `ghGet`'s 429 handling);
`civilDateTimeSchema` / `rollupDataPointSchema` / `dailyRollUpResponseSchema` in
`types.ts`; `ROLLUP_METRICS` / `foldRollupPoints` / `civilDateForLocalDay` /
`rollupRangeFor` / `chunkLocalDayRange` in `wellnessMap.ts` (pure, unit-tested);
wired into the SAME `ActivityAccumulator` the List-based `active-zone-minutes` /
`daily-resting-heart-rate` pass fills, in `wellness.ts`, so one `daily_activity`
row ends up carrying both List- and rollup-sourced metrics.

**Live-verified 2026-08-26** (`pnpm gh:wellness --since=2026-08-20
--until=2026-08-25 --only=activity`, real account): steps, distance and
calories all in plausible daily ranges (no repeat of the earlier ~102k "steps" blowup). Cross-checked
against independent GPS run data for the same days: the daily distance total
was consistently ≥ that day's actual run distance from `runs` — exactly the expected relationship (daily total = run + incidental
walking).

---

## 7. Sequencing

1. **A1** — schema: `(source, external_id)` identity migration (unblocks every
   non-Strava source). Small, do first.
2. **A2** — Google Health `oauth.ts` + `client.ts` + `types.ts` (no DB); verify
   against a real account in OAuth "test" mode.
3. **A3** — mapper + streams + ingest + sync; wire `pnpm gh:sync`.
4. **A4** — repoint Telegram `/sync`; deprecate `strava:sync` fully.
5. **B** — generic file importer (parallelizable; unblocks Samsung/Garmin now).
6. **C** — migrate Fitbit onto the Google Health client (hard deadline Sept 2026).

---

## 8. Open questions — verify with real credentials

- **Does `ExerciseRoute` need its own scope / user consent** beyond the base
  activity scope? (Health Connect gates routes separately; confirm the cloud API
  does or doesn't.) This is the single highest-risk unknown for the Fitbit-Air
  path — verify before A3.
- **Connected-GPS reliability:** the Fitbit Air has no GPS chip — a run only has a
  route if the **phone was carried and the Google Health app recorded it**. Runs
  without the phone will land HR+steps+distance-estimate but **no route/GPS pace**.
  Decide how the mapper flags a route-less run (store it, mark `start_lat/lng`
  null — weather-per-GPS enrichment simply won't fire).
- **OAuth verification:** restricted health scopes need Google's app verification
  for production; a single-user app can run in "test" mode with the owner as the
  sole test user. Confirm that's sufficient for the VPS deploy.
- **Rate limits / pagination** of `users.dataTypes.dataPoints` — size the sync
  pacing (mirror the Strava/Fitbit backoff).

---

## 9. Credentials the athlete will need (later)

- A **Google Cloud project** with the Google Health API enabled; OAuth client
  (client id/secret) + redirect URI → `.env.local`. Walkthrough at build time.
- Fitbit Air paired to the **Google Health app**; run with the **phone carried**
  so connected-GPS routes are captured.
- No Strava subscription. No Garmin partner approval. No Samsung developer
  registration (file export only).
