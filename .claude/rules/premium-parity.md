---
paths:
  - 'services/routing/**'
  - 'lib/relativeEffort.ts'
  - 'lib/racePrediction.ts'
  - 'lib/bestEfforts.ts'
  - 'lib/movingTime.ts'
  - 'lib/trainingLoad.ts'
  - 'services/adHocRoute.ts'
  - 'services/racePrediction.ts'
  - 'services/relativeEffort.ts'
  - 'lib/fuelingModel.ts'
  - 'services/fuelingBalance.ts'
---

# Premium-Parity Features

Features Strava keeps behind its paywall (or doesn't offer), reimplemented
on Agon's own data. Full build/verification narrative: tracked in Linear.

1. **Weather integration** — every run enriched with temperature, humidity,
   wind, conditions from Open-Meteo (free, keyless), joined on run start
   time + start GPS coordinates. Feeds HR-drift/sweat-rate analyses and the
   calendar sync (forecast on planned sessions). Runs automatically at the
   end of every sync entry point (`enrichMissingWeather`, MZY-226: sync
   scripts, Telegram `/sync`, live-recording finish) — `pnpm weather:backfill`
   is only for catch-up/`--force`. A run/ride with no GPS start uses home
   (`AGON_HOME_LAT`/`LNG` in `.env.local`, shared with route planning —
   `homeLocationOrNull()`), flagged `weather_location_estimated`,
   and is re-fetched at the real start once it gains GPS.
2. **PR predictions** for 1k/5k/10k/21.1k/42.2k/70k (`lib/racePrediction.ts`,
   → `fct_race_predictions`). Headline: Riegel power law with the exponent
   **recalibrated from the athlete's own best-effort pairs** via a log-log
   least-squares fit (generic k=1.06 kept as fallback); Daniels VDOT as a
   cross-check. 70k is an extrapolation with wide error bands — never a
   single number. Best-effort pairs come from `lib/bestEfforts.ts` — a
   two-pointer sliding-window search over any distance-bearing
   `run_streams` row (source-agnostic, not Strava-only), with a "beat the
   curve" filter so an ordinary training run can't drag the fit slower than
   the athlete's actual best efforts. Net-pace-corrected via
   `lib/movingTime.ts::buildNetAdjustedStream` (stop-corrected time/distance
   pairing) — freezes time AND distance together for a confirmed stop only
   (a lone flagged sample is noise, not a stop; see the Linear write-up for
   the two real bugs this guards against). Strava's paywalled
   `moving_time`/`elapsed_time` reference lives in
   `strava_activity_times` (`pnpm strava:times`, MZY-40). Re-run
   `pnpm strava:times --report` after any `computeMovingTime` change; the
   2026-09-26 baseline (moving flag 62 s MAE / −43 s bias, derived 87 s /
   −19 s, after MZY-217's recording-gap fix) is in
   `docs/methodology-log.md`. Bucket matching tolerates a stream 0.2% short
   of the distance (`findBucketEffort`), with time scaled at the run's own pace.
3. **Google Calendar sync** — `planned_sessions` pushed via OAuth
   (`services/googleCalendar/`): event title = session type, description =
   targets + per-exercise sets×reps (`lib/training/sessionDetails.ts`) + weather
   forecast when in range. `gcal_event_id` makes sync idempotent.
4. **Thorough weightlifting logging** — set-level granularity
   (`lifting_sessions` → `lifting_exercises` → `lifting_sets`). Captured via
   Telegram voice note; `lib/liftProgression.ts` (pure, unit-tested)
   computes e1RM (Epley/Brzycki) + volume-load — the mart/view are deferred
   until `lifting_sets` has real data (see Linear, MZY-32).
5. **Fueling & hydration model (runs + rides)** — `lib/fuelingModel.ts`
   (pure, unit-tested), shared by both activities (MZY-64). Intake = items
   (`run_fueling_items` / sibling `ride_fueling_items`) resolved against the
   shared `fueling_products` catalog. Est. sweat rate = baseline (latest
   `/sweat` observation, else `getAthleteProfile().sweatRateBaselineLPerH`)
   × intensity (%HRR from avg HR ÷ `REFERENCE_HRR` 0.65, clamped 0.5–1.5;
   no HR → 1, `intensity_method='assumed'`) × heat (±2%/°C vs 20 °C) ×
   humidity (+0.3%/RH-pt vs 50%). Deliberately NOT pace-based — pace→sweat
   doesn't transfer to cycling. Sodium loss = sweat volume ×
   `sweatSodiumMgPerL`. Outputs: net fluid/sodium, body-mass loss %,
   carbs/h vs. duration target (<1 h none · 1–2.5 h 30–60 · >2.5 h 60–90
   g/h), >2% dehydration and under-fueling flags — **NULL when no intake
   was logged** (didn't drink ≠ didn't log). Modelled for activities ≥ 60
   min or with intake; `pnpm fueling:backfill [--write]` →
   `run_fueling_balance` / `ride_fueling_balance` → `fct_run_fueling` /
   `fct_ride_fueling`. Not built yet: voice-note capture for rides (only
   `insertRideFuelingItem` exists).
6. **Route builder** — natural-language, target-distance running-route
   suggestions. Provider-neutral: OpenRouteService (`round_trip`,
   foot-walking) generates loops — Google Maps deliberately NOT used for
   generation (can't target a distance, and is billed). `services/routing/`:
   `RouteProvider` interface (the one swap point), pure `gpx.ts`/
   `mapsLink.ts`/`rank.ts`/`elevation.ts`/`weather.ts`/`diversity.ts`
   (all unit-tested). Constrained routes ("pass through X / finish at Y",
   MZY-215) are a point-to-point spine stretched to the target by ONE detour
   waypoint (`services/routing/detour.ts`): an AREA via (Nominatim OSM
   polygon, `area.ts` — natural/landuse/leisure preferred over a same-named
   admin boundary) has its waypoint moved around INSIDE the area (compass
   sweep, scored by straight-line gain; the inside-ray crosses ≤200 m cuts
   like the AVUS through Grunewald); otherwise a point is pushed perpendicular
   off the longest leg. The offset is found by secant/bisection (≤4 directions
   calls per direction). Only if no detour lands within 5% is the old
   pad-with-a-`round_trip`-loop composition (`compose.ts`) tried as a
   fallback. `finish` ≠ start ⇒ `oneWay` (labels/GPX say "one-way").
   Directions fall back to FOSSGIS OSRM (`osrmProvider.ts`, no elevation) once
   ORS reports quota exceeded (403 or 429), behind a per-process directions
   cache (`resilientProvider.ts`). Geocoding fetches 5 Pelias hits and scores
   each by query words in its own name (weighted 1.5×) plus words in its
   street/Bezirk/postcode (`pickBestFeature`). A hit that doesn't account for
   the query's first comma segment carries a `warning`, surfaced as
   `geocodeWarnings` in the CLI / MCP / Telegram output (MZY-219).
   Ranking: distance
   accuracy → flattest → wind-exposure tiebreak (varies by candidate
   bearing); heat is a displayed caveat, not a ranking input (doesn't vary
   by candidate within one call). 3 directionally-diverse routes generated
   per run, not 1 (`diversity.ts`). Output: GPX (primary, for the watch) +
   a Google Maps deep-link (secondary, ~9-waypoint cap — `mustInclude`
   pins the through/finish points, then remaining slots are filled by
   shape: greedy max-deviation from the chord, so Maps' own shortest-path
   re-routing between vias can't shortcut detours — even spacing ran 9.3%
   short on average, shape selection 1.35%; MZY-31).
   MCP `suggest_routes` tool is read-only; saving/attaching is CLI-only
   (`pnpm route:suggest`/`route:attach`). Telegram `/route <km> [through …]
[finish …] [bike] [date]` persists ad-hoc routes (`kind='adhoc'`) under a
   dedicated calendar section, independent of auto-suggested routes — a
   `bike`/`cycle`/`ride` keyword anywhere in the text switches the ORS
   profile to `cycling-regular` (default `foot-walking`; docs/
   telegram-commands.md has the full keyword list). Bike preferences
   (MZY-67) use only what ORS offers: surface = the profile itself
   (`road` → `cycling-road`, `gravel` → `cycling-mountain`), hills =
   `profile_params.weightings.steepness_difficulty` (`flat` 0 / `hilly` 3,
   documented for cycling-* profiles only); no bike-lane option exists. Also
   on MCP `suggest_routes` (`mode`, `hills`) and `route:suggest`
   (`--mode`, `--hills`). Still attached to that
   day's run session (no separate ride-session concept in the calendar
   sync yet). `gcal:sync` auto-attaches routes to run events with a target
   distance, throttled (`ORS_MIN_INTERVAL_MS`) to stay under the ORS free
   tier. Not built, deliberately deferred: a GraphHopper adapter, PWA map
   rendering (see Linear, MZY-42).
7. **Relative Effort** — per-activity Banister TRIMP from the `run_streams`
   HR series (`lib/relativeEffort.ts`, pure, unit-tested): `HRr = (HR −
HR_rest)/(HR_max − HR_rest)` (anchors from `getAthleteProfile()`), TRIMP
   weight `HRr · 0.64 · e^(1.92·HRr)`, integrated over the stream (avg-HR
   fallback when no stream). → `fct_relative_effort`. Rides get the same
   treatment as a sibling table (`ride_relative_effort` →
   `fct_ride_relative_effort`, `scripts/backfill-relative-effort-rides.ts`,
   no pace→HR estimate tier since that fit is running-pace-specific); the
   two daily SUMs UNION together (`services/trainingLoad.ts`
   `loadDailyRelativeEffort`) to feed `fct_training_load_daily` (CTL/ATL/TSB,
   `lib/trainingLoad.ts` — sequential EWMA over a continuous date spine:
   CTL 42d, ATL 7d, TSB=CTL−ATL prev-day). Credit GoldenCheetah/sweatpy for
   the TRIMP model (GPL-3.0 — formulas only, no code copied, per the Prior
   Art policy). Validate against captured reference points by **trend and
   shape**, not absolute magnitude (different unit scales than Strava's own
   number).
8. **Ride power** (MZY-267 storage, MZY-269 derived metrics). Storage
   with provenance plus summary ingest (see `.claude/rules/run-ingestion.md`
   "Ride power"), shown as "estimated" in MCP `recent_rides`, on ride
   detail and in `fct_ride_power`. **Derived metrics, shipped but empty
   until a power meter exists**: `lib/power.ts` computes NP (1 Hz resample,
   30 s trailing rolling mean, 4th-power mean), IF, TSS and a mean-maximal
   curve over 14 durations (1 s … 2 h, `POWER_CURVE_DURATIONS_S`; skipped
   when longer than the ride; true maxima, NOT forced monotonic). Resample
   rule: null/negative/>3000 W = 0 W; gaps ≤ 5 s hold the last value; longer
   gaps (stops, auto-pause) are removed, so a café stop doesn't lower NP.
   Read **only from `ride_streams` rows with `watts_source = 'device'`**
   (`services/ridePowerMetrics.ts loadDeviceWattsStreams` is the single
   gate; the richest device stream wins). Stored in `ride_power_metrics`
   (one row per ride; `ftp_w` = the FTP used) and `ride_power_curve` (one
   row per ride × duration). FTP: optional `ftpHistory [{watts, date}]` in
   the athlete profile, `ftpOn(date)` picks the entry in force; no FTP →
   NP + curve only, IF/TSS null (a CHECK enforces it). Written by the
   `power_metrics` step of `recomputeDerivedForActivity` (rides only) and
   `pnpm power:backfill-metrics` (dry run; `--write`); a recompute with no
   device stream deletes the row. Surfaced in MCP `recent_rides` (NP/IF/
   TSS columns), ride detail (field + `PowerCurveChart`), `fct_ride_power`
   and `fct_ride_power_curve`. **Decision: TSS never enters training
   load.** Load stays the Relative Effort (TRIMP) sum over runs and rides,
   the one unit every sport has. TSS is a separate per-ride metric, so no
   ride is counted twice. A possible later `'power'` method in
   `ride_relative_effort` would convert TSS to TRIMP through a calibrated
   ratio, for HR-less meter rides only, and would replace that ride's
   single score rather than add to it. Formulas: Allen & Coggan
   (published); sweatpy (MIT) as reference only. Reimplemented, and no
   GoldenCheetah code copied (GPL). CREDITS.md #16.

## References

- Busso T. (2003). Non-linear systems identification to describe the
  relationship between training load and performance. _Journal of Applied
  Physiology_.
- Banister EW. (1991). Modeling elite athletic performance. In:
  _Physiological Testing of Elite Athletes_. Human Kinetics.
- Hultman E. et al. (1996). Muscle creatine loading in men. _Journal of
  Applied Physiology_, 81(1), 232–237 (creatine loading protocol
  reference — see the nutrition creatine goal in
  `.claude/rules/nutrition.md`).
