# Open-Source Landscape Scan — Where Agon Fits

> Competitive scan of the open-source **fitness / training / self-tracking** ecosystem, run to
> answer one question: *is there room for Agon to add something genuinely new to the open-source
> domain, or is this ground already taken?*

**Date:** 2026-07-24
**Method:** 6 parallel research agents (one per slice), each sweeping GitHub, awesome-selfhosted,
r/selfhosted, r/QuantifiedSelf, and the MCP registries (modelcontextprotocol/servers, glama.ai,
pulsemcp). ~70 projects surfaced; the 7 most relevant to Agon are analyzed in depth. Star counts
and last-commit years are approximate (rough GitHub reads, not pinned).

> **Newer section:** [2026-10-08 — Phone activity recorders (GPS + BLE, screen-off)](#2026-10-08--phone-activity-recorders-gps--ble-screen-off)
> extends this scan for the Android recorder (`app/record`, `lib/ble/`, `lib/gps/`). It also
> corrects two licence/star readings below (OpenTracks, GoldenCheetah).

**Scope note:** the request said "job-seeking tools" — read here as **fitness / self-tracking
tools**, the competitive space Agon actually lives in. If literal job-hunting tooling was meant,
this scan is off-target; flag it and it'll be redone.

---

## TL;DR — the verdict

**No single open-source project is Agon. But almost every *individual component* of Agon already
exists in the open, and several are far more popular than Agon will be for a long time.** The
differentiation is the **vertical integration**, not any one piece.

What's **commoditized** (do not pitch these as the headline — the headline is taken):

- **MCP-over-fitness-data is table stakes.** Strava alone has 9+ MCP servers; Garmin, Whoop, Oura,
  Fitbit, and Apple Health each have several. Open Wearables bundles them *and* ships its own MCP
  server, covering more sources than Agon plans to.
- **AI chat-logging of food/workouts/weight is done and popular.** SparkyFitness (~4.9k★) and
  HealthLog already log conversationally into a self-hosted DB with AI insights.
- **The Telegram-voice → Whisper → LLM → structured-log pipeline exists** (notes-bot,
  telegram-llm-bot, CalorieBot). The credit-free `claude` CLI twist is a nice cost optimization,
  not a new idea.
- **LLM running/strength coaches on Strava data are a crowded hobby space** — but almost all are
  low-star, single-dev, and shallow (plan generation + prose, not analytics).

What is **genuinely unoccupied** (lead with these):

1. **Concurrent run + lift load modeling.** The entire field splits cleanly into endurance-only
   (GoldenCheetah, OpenAthlete, Endurain, FitTrackee) or strength-only (Liftosaur, Flexify).
   **wger is the only tool attempting both, and shallowly.** A fused hybrid-athlete training-load
   signal + cross-domain correlations (lift output vs. prior-day run load, deficit vs. HR drift)
   has **no open-source peer**.
2. **Intra-session run fueling & hydration modeling.** Every nutrition tool models *daily*
   calories/macros. **None** models *what was consumed at km 8 of a specific run*, sweat-rate ×
   weather × HR fluid-loss estimation, or sodium balance vs. intake. Agon's `run_fueling_items.
   timing_km` + `fct_run_fueling` + `/sweat` recalibration is white space against the whole field,
   not just against Strava.
3. **A real analytics warehouse (dbt/Lightdash on Postgres) instead of app-embedded charts or a
   metrics bucket.** The self-hosted crowd runs InfluxDB+Grafana (arpanghosh stack) or hardcoded
   app charts. Nobody ships versioned, tested `fct_*` marts (Banister CTL/ATL/TSB, e1RM/volume-load,
   Riegel/VDOT race prediction with personalized recalibration).
4. **Vault-grounded consulting.** Competitors' AI (where it exists) relies on raw model priors.
   None ground answers in a curated private sports-science evidence vault. This is the part of the
   MCP story that *isn't* commoditized.

**Positioning recommendation:** lead with the **analytics + fueling/hydration + vault-grounded
consulting depth for one serious hybrid athlete**. Treat "voice logging via Telegram + MCP" as
necessary infrastructure, not the pitch — that headline is already taken.

---

## The 7 deep dives

Selected as the most architecturally relevant to Agon across all slices.

### 1. SparkyFitness — the closest full-stack analog
`https://github.com/CodeWithCJ/SparkyFitness` · ~4.9k★ · React/TS + Node/TS + Postgres · self-hosted, very active

The most-starred project in the entire scan and the closest structural cousin. Docker-deployed,
documented REST API, native mobile apps, multi-source food resolution (USDA, OpenFoodFacts,
FatSecret, Nutritionix), and **"SparkyAI"** — a chatbot that logs food/exercise/body-stats
conversationally and estimates calories from meal photos. Broad domain coverage (hydration, sleep,
fasting, mood), family/multi-user.

**Where Agon differs:** SparkyFitness models *daily* totals — no concept of carbs/sodium consumed
*at km 8 of a run*, no sweat-rate baseline, no fluid/sodium-balance-vs-loss tied to weather + HR.
Its AI is a general chatbot, not a zod-validated structured-extraction pipeline into typed tables.
No endurance training-load, no e1RM block progression, no MCP server for *external* LLMs. Agon
competes on endurance+strength depth and the credit-free local voice path, **not** on general food
logging (where Sparky wins outright).

### 2. Open Wearables — the closest "unified DB + MCP" thesis
`https://github.com/the-momentum/open-wearables` · ~2.2k★ · Python/FastAPI + React/TS · self-hosted, active 2026

The most serious competitor *by ambition*. OAuths into 10 providers (Garmin, Oura, Whoop, Strava,
Fitbit, Polar, Suunto + Apple HealthKit / Samsung Health / Google Health Connect), normalizes into
one shared model, and exposes a unified API, webhooks, embeddable widgets, **and an MCP server**
(`/mcp`) plus a companion app for continuous Apple Health sync. MIT, single-tenant. This is Agon's
exact "unified health DB + MCP consulting layer" thesis — already built, popular, and broader on
sources.

**Where Agon differs:** it's a general-purpose *ingestion API/platform for developers*, not a
personal analytics product. No training-load/CTL-ATL-TSB, no lift-progression/e1RM, no
fueling/hydration/sweat model, no weather enrichment, no plan-vs-actual compliance, no voice-note
capture (its AI assistant is "coming soon," chat-only), and no sports-science-vault grounding. It
normalizes-and-stores; Agon *reasons over* a hybrid athlete's data with dbt marts + vault-grounded
consulting. **This is the repo to watch most closely** — it's the one that could grow into Agon's
lane. Also the best reference for eventually widening Agon's source list.

### 3. wger — the category-leading self-hosted platform
`https://github.com/wger-project/wger` · ~6.5k★ · Python/Django + Flutter + Postgres · self-hosted, daily commits

The longest-lived, most-starred FLOSS fitness platform and the closest analog to Agon's *non-voice*
half. Set-level lifting logging, nutrition (Open Food Facts), body weight, custom measurements,
progress photos, rule-based weight progression, a comprehensive REST API, native Flutter apps,
one-command Docker. Rare in that it unifies workout + nutrition + bodyweight — the same "one
platform" ambition as Agon.

**Where Agon differs:** no ingestion from Strava/Fitbit/Polar (manual/API-push only), no
weather/HR-stream enrichment, no LLM/voice capture, no derived sports-science analytics
(CTL/ATL/TSB, VDOT, sweat/fueling), no MCP layer. Its "analytics" are basic charts, not a dbt
warehouse. Its lifting logger is set-based but not tuned for e1RM/volume-load block progression.
**Borrow from it:** REST API design and exercise-catalog schema are proven references.

### 4. GoldenCheetah — the deepest sports-science engine
`https://github.com/GoldenCheetah/GoldenCheetah` · ~2.2k★ · C++/Qt desktop · local data, active 2026

The reference implementation for open endurance analytics. Imports FIT/GPX/TCX and computes the
full Performance Manager Chart (**CTL/ATL/TSB via the Banister impulse-response model** Agon's
`fct_training_load_daily` targets), power-duration/critical-power curves, W'bal, VO2 estimates.
Embedded Python/R console + metric API. Companion library **`sweatpy`**
(`https://github.com/GoldenCheetah/sweatpy`) is a direct source of validated load formulas.

**Where Agon differs:** single-machine desktop C++ app — no server/API/Postgres, no weather
enrichment, no fueling/hydration model, and no concurrent run+lift load (lifting is an
afterthought; it's cycling/endurance-centric). **Borrow, don't reinvent:** mine GoldenCheetah/
sweatpy for the CTL/ATL/TSB and critical-power math before writing the marts.

### 5. OpenAthlete — the closest structural analog for training-load
`https://github.com/openathleteorg/openathlete` · ~53★ · TypeScript full-stack · self-hosted, active 2026

Exactly Agon's stack direction: a modern, self-hostable **TypeScript** web platform pitched as an
open TrainingPeaks alternative, with **transparent, auditable CTL/ATL/TSB algorithms in code** and
multi-device sync (Strava, Garmin, Suunto, Polar, Coros). The single best readable reference for
`fct_training_load_daily` before you write it.

**Where Agon differs:** early/low-maturity, endurance-only (no strength model), no fueling/hydration
balance, no weather enrichment, and — critically — no LLM/voice capture and no dbt analytics marts.
Agon's hybrid run+lift load, `fct_run_fueling`, voice ingestion, and MCP consulting layer are all
absent here.

### 6. HPI (Human Programming Interface) — the QS philosophical cousin
`https://github.com/karlicoss/HPI` · ~1.6k★ · Python library · local, active

The closest philosophical relative to Agon's data-backbone layer: a Python package where each data
source is a *module* exposing typed, iterable objects (`my.body.weight`, `my.runs`, `my.location`),
normalizing dozens of exports/APIs behind one import surface. Serious commitment to typed schemas
and a "bring your own modules" extension model — exactly the "unified schema, extensible to other
life domains later" posture Agon wants.

**Where Agon differs:** HPI is a *read/normalize library for a developer* — no opinionated domain
model, no low-friction capture, no consulting layer; you query it from Python. Agon ships the
opinionated athlete schema, the zero-friction Telegram capture, and the MCP consulting layer that
HPI deliberately leaves to the user. **Notable trend:** the schema-ambitious QS aggregators keep
dying (QS Ledger dead ~2019, Fluxtream abandoned, Fasten's self-hosted PHR *archived 2026-07-18*) —
the "aggregate everything, self-hosted" space repeatedly fails on maintenance burden. Agon's
single-user, opinionated, narrow-then-expand scope is a defensible answer to why.

### 7. arpanghosh8453 stack (garmin-grafana / fitbit-grafana) — what the self-hosted crowd actually runs
`https://github.com/arpanghosh8453/garmin-grafana` (~3.4k★) · `https://github.com/arpanghosh8453/fitbit-grafana` (~905★) · Python + Docker + InfluxDB + Grafana · self-hosted, active

The de-facto standard for self-hosted wearable dashboards, and the most direct overlap with Agon's
*ingestion* layer. Dockerized Python daemons poll the Garmin/Fitbit APIs on a schedule, write
HR/sleep/HRV/steps/stress/body-battery into InfluxDB, and auto-provision Grafana dashboards, with
**rate-limit-aware historical backfill** (Fitbit's 150 calls/hr).

**Where Agon differs:** single-source storage-and-visualize pipelines with no cross-domain analytics
and no derived training science. InfluxDB is a metrics bucket, not a relational model — no set-level
lifting, no normalized run↔fueling↔weather joins, no plan-vs-actual, no PR/VDOT predictions. Grafana
panels can't do e1RM regressions, Banister CTL/ATL/TSB, or fueling-vs-loss balance the way dbt marts
on Postgres can. **Borrow, don't reinvent:** the rate-limit-aware Fitbit backfill pattern is
battle-tested — mirror it.

---

## Full catalog — every tool found, with GitHub URLs

Deduplicated across slices; a tool that spans categories is listed once under its primary slice.
Star counts are rough; "small/low" = resolves but sub-hundred / personal project.

### A. Workout & strength trackers

| Name | GitHub URL | Stars | Stack | Self-host | Active |
|---|---|---|---|---|---|
| wger ★ | https://github.com/wger-project/wger | ~6.5k | Django/Flutter | Yes | 2026 |
| workout-tracker (jovandeginste) | https://github.com/jovandeginste/workout-tracker | ~1.2k | Go + htmx | Yes | 2026 |
| Liftosaur | https://github.com/astashov/liftosaur | ~630 | TS/Preact (AWS) | No (SaaS) | 2026 |
| wingfit | https://github.com/itskovacs/wingfit | ~510 | Angular + FastAPI | Yes | 2025 |
| LiftLog | https://github.com/LiamMorrow/LiftLog | ~510 | .NET MAUI / RN | Local-first | 2026 |
| Flexify | https://github.com/brandonp2412/Flexify | ~400 | Flutter | Offline | 2026 |
| FastNFitness | https://github.com/brodeurlv/fastnfitness | ~320 | Java/Android | Offline | 2026 |
| lyftr | https://github.com/Cawlumm/lyftr | ~180 | TypeScript | Yes | 2026 |
| FitBook | https://github.com/brandonp2412/FitBook | ~160 | Flutter | Offline | 2026 |
| openWorkout (oliexdev) | https://github.com/oliexdev/openWorkout | ~150 | Java/Android | Offline | 2025 |
| MyFit | https://github.com/WhyAsh5114/MyFit | ~140 | TS PWA | Yes | 2026 |
| openGym | https://github.com/DuarteSantos8/openGym | ~90 | JavaScript | Yes | 2026 |
| Body.build | https://github.com/Dieterbe/body.build | ~35 | JS/Flutter | Offline | 2026 |
| Massive (deprecated → Flexify) | https://github.com/brandonp2412/Massive | ~30 | RN | Offline | 2025 |
| lifttrace | https://github.com/TraceApps/lifttrace | ~23 | Svelte | Yes | 2026 |
| stronk | https://github.com/bcspragu/stronk | ~17 | Go/Svelte | Yes | 2026 |
| GymRoutines | https://github.com/noahjutz/GymRoutines | ~16 | Kotlin/Android | Offline | 2023 |
| gym-tracker (jessedelira) | https://github.com/jessedelira/gym-tracker | ~15 | TS PWA | Yes | 2025 |
| skulpt | https://github.com/skulptapp/skulpt | ~7 | RN | Local-first | 2026 |

*Also on GitLab/Codeberg (out of GitHub scope): Feeel, FitoTrack (conditioning/outdoor).*

### B. Running / endurance / training-load analytics

| Name | GitHub URL | Stars | Stack | Self-host | Active |
|---|---|---|---|---|---|
| GoldenCheetah ★ | https://github.com/GoldenCheetah/GoldenCheetah | ~2.2k | C++/Qt | Desktop | 2026 |
| Endurain | https://github.com/endurain-project/endurain | ~2.1k | FastAPI + Vue3 | Yes | 2026 |
| Dreeve (ex Statistics-for-Strava) | https://github.com/dreeveapp/dreeve | ~1.9k | PHP/Symfony | Yes | 2026 |
| OpenTracks | https://codeberg.org/OpenTracksApp/OpenTracks | ~1.4k | Java/Android | On-device | 2025 (moved off GH) |
| FitTrackee | https://github.com/SamR1/FitTrackee | ~1.1k | Flask + Vue/TS | Yes | 2026 |
| gpxpy (lib) | https://github.com/tkrajina/gpxpy | ~1.1k | Python | Library | active |
| stravalib (lib) | https://github.com/hozn/stravalib | ~991 | Python | Library | 2026 |
| python-fitparse (lib) | https://github.com/dtcooper/python-fitparse | ~817 | Python | Library | forked/maintained |
| Grafana Strava datasource | https://github.com/grafana/strava-datasource | ~221 | Go + TS | Grafana | active |
| fitdecode (lib) | https://github.com/polyvertex/fitdecode | ~213 | Python | Library | maintained |
| pytrainer | https://github.com/pytrainer/pytrainer | ~129 | Python/GTK | Desktop | low |
| sweatpy (lib) | https://github.com/GoldenCheetah/sweatpy | ~79 | Python | Library | in revision |
| OpenAthlete ★ | https://github.com/openathleteorg/openathlete | ~53 | TypeScript | Yes | 2026 |
| Runalyze (OSS repo, archived) | https://github.com/Runalyze/Runalyze | ~226 | PHP | Yes (old) | archived 2019 |
| SportTracks training-load plugin | https://github.com/mechgt/training-load | small | C#/.NET | Desktop | legacy |
| grava | https://github.com/rotti/grava | small | Python | Yes | niche |

*Verified closed-source (excluded): Intervals.icu (core proprietary; only community API clients open), Runalyze's current hosted product.*

### C. Health-data aggregators & wearable sync

| Name | GitHub URL | Stars | Stack | Self-host | Active |
|---|---|---|---|---|---|
| Gadgetbridge | https://codeberg.org/Freeyourgadget/Gadgetbridge | ~7k | Android | On-device | 2026 (GH is stale redirect) |
| openScale | https://github.com/oliexdev/openScale | ~2.4k | Android | On-device | 2025 |
| Open Wearables ★ | https://github.com/the-momentum/open-wearables | ~2.2k | FastAPI + React | Yes | 2026 |
| garmin-grafana ★ | https://github.com/arpanghosh8453/garmin-grafana | ~3.4k | Python/InfluxDB | Yes | 2026 |
| fitbit-grafana ★ | https://github.com/arpanghosh8453/fitbit-grafana | ~905 | Python/InfluxDB | Yes | 2025 |
| openfit | https://github.com/FlavioAdamo/openfit | ~262 | TS/Electron | Desktop | 2025 |
| health-auto-export-server | https://github.com/HealthyApps/health-auto-export-server | ~158 | Node/MongoDB | Yes | 2024 |
| apple-health-ingester | https://github.com/irvinlim/apple-health-ingester | ~112 | Go | Yes | 2024 |
| fitness-dashboard (jlai) | https://github.com/jlai/fitness-dashboard | ~82 | Next.js | Yes | 2026 |
| Elevate | https://github.com/daylen/elevate | ~25 | Node/React/Mongo | Yes | quiet |
| ha-google-fit | https://github.com/YorkshireIoT/ha-google-fit | mid | Python (HA) | Yes | active |
| home-assistant-google_fit | https://github.com/cyberjunky/home-assistant-google_fit | mid | Python (HA) | Yes | quiet |
| gofit | https://github.com/timatooth/gofit | small | Go | Yes | — |
| garmin-connect-influxdb | https://github.com/maust/garmin-connect-influxdb | small | Python | Yes | — |
| apple-health-exporter | https://github.com/mganjoo/apple-health-exporter | small | Python | Script | — |
| applehealth (krumjahn) | https://github.com/krumjahn/applehealth | small | Python | Script | — |
| Withings-API-Exporter | https://github.com/zsomborjoel/Withings-API-Exporter | small | Java/Spring | Yes | — |
| withings-exporter | https://github.com/issyl0/withings-exporter | small | Python | Yes | — |
| python_withings_api (lib) | https://github.com/vangorra/python_withings_api | mid | Python | Library | — |

### D. Nutrition & fueling

| Name | GitHub URL | Stars | Stack | Self-host | Active |
|---|---|---|---|---|---|
| SparkyFitness ★ | https://github.com/CodeWithCJ/SparkyFitness | ~4.9k | React/Node/Postgres | Yes | 2026 |
| OpenNutriTracker | https://github.com/simonoppowa/OpenNutriTracker | ~2.2k | Flutter | Optional | 2026 |
| Waistline | https://github.com/davidhealey/waistline | ~723 | Cordova/Android | Local | active |
| Food You | https://github.com/maksimowiczm/FoodYou | ~508 | Kotlin/Android | Local | 2026 |
| PANTS (price+nutrition) | https://github.com/dylanleigh/PriceAndNutritionTrackingSystem | ~131 | Django | Yes | moderate |
| food-diary (pkirilin) | https://github.com/pkirilin/food-diary | ~28 | .NET + React | Yes | 2026 |
| kcal | https://github.com/kcal-app/kcal | low | Laravel/PHP | Yes | varies |
| NutriCal | https://github.com/thehellberg/NutriCal | low | — | Yes | WIP |
| Calories-In | https://github.com/vangelov/calories-in | low | React | Static | low |
| NutriLog-App | https://github.com/Nutrilog/NutriLog-App | low | — | — | low |
| DietCli | https://github.com/hstsethi/dietcli | low | C++ | CLI | low |
| Open Food Facts (smooth-app) | https://github.com/openfoodfacts/smooth-app | large | Flutter | Client | 2026 |

**Open food databases (reference data, not competitors):**
- **BLS (Bundeslebensmittelschlüssel)** — the German national food database (Max Rubner-Institut),
  CC BY 4.0. **Primary source for a Berlin-based athlete**; already integrated by OpenNutriTracker.
- **Open Food Facts** — https://world.openfoodfacts.org/ (API: https://openfoodfacts.github.io/openfoodfacts-server/api/)
  — strong German/EU barcode coverage for packaged goods.
- USDA FoodData Central — https://fdc.nal.usda.gov/ (API: https://fdc.nal.usda.gov/api-guide.html)
  — CC0 fallback for generic whole foods.

Recommended `fueling_products` resolution stack for Berlin: **BLS + Open Food Facts primary, USDA
fallback** — mirror OpenNutriTracker's multi-source selection rather than building it from scratch.

### E. Quantified-self / personal-data platforms

| Name | GitHub URL | Stars | Stack | Self-host | Active |
|---|---|---|---|---|---|
| ActivityWatch | https://github.com/ActivityWatch/activitywatch | ~17.8k | Python/Rust/Vue | Yes | 2025 |
| Habitica | https://github.com/HabitRPG/habitica | ~13k | Node/Vue | Yes | active |
| Loop Habit Tracker (uhabits) | https://github.com/iSoron/uhabits | ~10.1k | Kotlin/Android | Local | 2025 |
| Fasten Health (on-prem, archived) | https://github.com/fastenhealth/fasten-onprem | ~2.8k | Go + Angular (FHIR) | Yes | **archived 2026-07** |
| Promnesia | https://github.com/karlicoss/promnesia | ~1.9k | Python | Local | 2025 |
| HPI ★ | https://github.com/karlicoss/HPI | ~1.6k | Python | Local | 2025 |
| QS Ledger | https://github.com/markwk/qs_ledger | ~1.1k | Python/Jupyter | Local | dead (~2019) |
| LibreHealth EHR (clinical) | https://github.com/LibreHealthIO/lh-ehr | ~700 | PHP | Yes | semi |
| healthkit-to-sqlite (Dogsheep) | https://github.com/dogsheep/healthkit-to-sqlite | ~248 | Python/SQLite | Local | mature/low |
| Dogsheep (org) | https://github.com/dogsheep | org | Python/Datasette | Local | sporadic |
| Fluxtream | https://github.com/fluxtream/fluxtream-app | ~140 | Java | Yes | abandoned |
| OpenMRS (clinical) | https://github.com/openmrs | org | Java/React | Yes | active |
| awesome-quantified-self (markwk) | https://github.com/markwk/awesome-quantified-self | list | — | — | semi |
| awesome-quantified-self (woop) | https://github.com/woop/awesome-quantified-self | list | — | — | semi |

### F. AI/LLM, chat-bot logging & MCP health servers  *(differentiation slice)*

| Name | GitHub URL | Stars | Sub-category | Active |
|---|---|---|---|---|
| SparkyFitness | https://github.com/CodeWithCJ/SparkyFitness | ~4.9k | LLM coach + logging | 2026 |
| garmin_mcp (Taxuspt) | https://github.com/Taxuspt/garmin_mcp | ~828 | MCP server | 2025 |
| strava-mcp (r-huijts) | https://github.com/r-huijts/strava-mcp | ~455 | MCP server | 2025 |
| HealthLog (MBombeck) | https://github.com/MBombeck/HealthLog | ~37 | LLM coach + logging (Next.js/Postgres) | 2025 |
| garmin-connect-mcp (eddmann) | https://github.com/eddmann/garmin-connect-mcp | low | MCP server | 2025 |
| strava-mcp (eddmann) | https://github.com/eddmann/strava-mcp | low | MCP server | 2025 |
| strava-mcp (kw510, Workers) | https://github.com/kw510/strava-mcp | low | MCP server (hosted) | 2025 |
| strava-mcp-kit (Guutong) | https://github.com/Guutong/strava-mcp-kit | low | MCP server (read+write) | 2025 |
| whoop-mcp (JedPattersonn) | https://github.com/JedPattersonn/whoop-mcp | ~13 | MCP server | 2025 |
| whoop-mcp (elizabethtrykin) | https://github.com/elizabethtrykin/whoop-mcp | low | MCP server | 2025 |
| oura-mcp-server (tomekkorbak) | https://github.com/tomekkorbak/oura-mcp-server | low | MCP server | 2025 |
| oura-mcp (davidmosiah) | https://github.com/davidmosiah/oura-mcp | low | MCP server | 2025 |
| fitbitmcp (davidmosiah) | https://github.com/davidmosiah/fitbitmcp | low | MCP server | 2025 |
| apple-health-mcp-server (the-momentum) | https://github.com/the-momentum/apple-health-mcp-server | mid | MCP server (DuckDB) | 2025 |
| apple-watch-health-mcp (salgado) | https://github.com/salgado/apple-watch-health-mcp | low | MCP server | 2025 |
| personal-mcp (evangstav) | https://github.com/evangstav/personal-mcp | ~10 | MCP + logging | 2024 |
| nutrition-mcp (akutishevsky) | https://github.com/akutishevsky/nutrition-mcp | low | MCP + logging | 2025 |
| fitness_coach_MCP (Dinesh-Satram) | https://github.com/Dinesh-Satram/fitness_coach_MCP | low | MCP + LLM coach | 2025 |
| TrainingPeaks MCP (JamsusMaximus) | https://github.com/JamsusMaximus/trainingpeaks-mcp | small | MCP server | new |
| claude-running-coach (ColinEberhardt) | https://github.com/ColinEberhardt/claude-running-coach | ~14 | LLM coach (Claude Skills) | 2025 |
| trAIner (Joe-Heffer) | https://github.com/Joe-Heffer/trainer | ~1 | LLM coach (Strava+Gemini) | 2026 |
| strava-openai-coach (mlamberts78) | https://github.com/mlamberts78/strava-openai-coach | low | LLM coach | 2025 |
| TrainerAI (CogitoNTNU) | https://github.com/CogitoNTNU/TrainerAI | low | LLM coach | 2024 |
| notes-bot (fahadhasin) | https://github.com/fahadhasin/notes-bot | ~0 | Voice pipeline (Telegram+Whisper+Ollama) | 2026 |
| telegram-llm-bot (ma2za) | https://github.com/ma2za/telegram-llm-bot | low | Voice pipeline (Ollama+faster-whisper) | 2025 |
| calorie_counter (ilyamil) | https://github.com/ilyamil/calorie_counter | low | Logging bot (Telegram, YOLOv3) | older |
| foodbot (lelika1) | https://github.com/lelika1/foodbot | low | Logging bot (Telegram, Go) | older |
| nutri-scan (teslakoile) | https://github.com/teslakoile/nutri-scan | low | Logging bot (Discord, GPT-4V) | 2024 |
| nutri-bot (NikitiusIvanov) | https://github.com/NikitiusIvanov/nutri-bot | low | Logging bot (Telegram, Gemini) | 2024 |

*Unverified: `jokkebk/mealgram` (Gemini food-diary Telegram bot) surfaced in search but 404'd — likely renamed/moved.*

---

## Where Agon is genuinely differentiated (the combination, not any single piece)

- **Set-level lifting + fueling/hydration + sweat-rate modeling tied to a real periodized hybrid
  program.** No scanned project does normalized set-level logging *and* a sweat-loss/sodium fueling
  model *and* endurance load. Most do exactly one domain.
- **Intra-session, timed run fueling vs. physiologically-estimated losses** (`run_fueling_items.
  timing_km`, `fct_run_fueling`, `/sweat` recalibration, per-serving Na/K/Mg/caffeine, weather- and
  HR-adjusted loss). Occupied by *nobody* — this is Agon's clearest white space.
- **Concurrent run + lift training-load** and Phase-4 cross-domain correlations (lift output vs.
  prior-day run load, deficit vs. HR drift, TSB-threshold overreach flags). No open-source analog.
- **Sports-science knowledge-vault grounding** for the consulting layer. Competitors' AI relies on
  raw model priors; none ground answers in a curated evidence vault.
- **A tested dbt/Lightdash warehouse of premium-parity marts** (Banister CTL/ATL/TSB, e1RM/volume-
  load, Riegel/VDOT with *personalized recalibration*, dehydration/under-fuel flags) instead of
  app-embedded charts or an InfluxDB bucket.

## Where Agon should borrow, not reinvent

| Need | Borrow from |
|---|---|
| CTL/ATL/TSB + critical-power math | **GoldenCheetah** + **sweatpy** (validated formulas) |
| Readable TS training-load reference | **OpenAthlete** (auditable algorithms in code) |
| Rate-limit-aware Fitbit backfill | **arpanghosh8453/fitbit-grafana** (battle-tested pattern) |
| Strava streams ingestion / FIT parsing | **stravalib**, **python-fitparse** / **fitdecode** |
| Multi-source food resolution for `fueling_products` | **OpenNutriTracker** (BLS-Germany + Open Food Facts + USDA) |
| REST API + exercise-catalog schema | **wger** |
| Progression-rule DSL for `planned_sessions` | **Liftosaur**'s Liftoscript (study the model) |
| User migration paths (import formats) | **openGym** (FitNotes/Strong/Hevy importers) |
| Eventual wider source coverage | **Open Wearables**' normalized 10-provider model |

## Licensing — what you may actually reuse

**This distinction governs everything below.** Software licenses split into two camps that determine
whether you can copy *code* or only reimplement *ideas*:

- **Permissive (MIT / Apache-2.0 / BSD / ISC)** — you may copy source into Agon, modify it, and keep
  Agon under whatever license you like, as long as you **retain the copyright/attribution notice**.
  Low friction. *In this scan:* Open Wearables (MIT), python-fitparse (MIT), fitdecode (MIT),
  gpxpy (Apache-2.0), stravalib (Apache-2.0/MIT — verify), most MCP servers (MIT).
- **Copyleft (AGPL-3.0 / GPL-3.0)** — if you copy their **code** into Agon, Agon must itself become
  AGPL/GPL, and **AGPL additionally requires you to publish source to anyone who uses the app over a
  network** (a real constraint for a hosted service). You may still freely **reimplement the idea**
  from scratch and **use openly-licensed data/formulas** — algorithms and mathematical formulas are
  not copyrightable. *In this scan:* wger (AGPL-3.0), Liftosaur (AGPL-3.0), lifttrace (AGPL-3.0),
  LiftLog sync server (AGPL-3.0), GoldenCheetah (GPL-3.0), OpenNutriTracker (GPL-3.0).
- **Data licenses** are separate from code: BLS (CC BY 4.0 — attribute), Open Food Facts (ODbL for
  the DB — share-alike on derived databases; attribute), USDA FoodData Central (CC0 — no strings).

**Rule of thumb for Agon:** copy code only from **permissive** repos (retain their notice);
from **copyleft** repos, reimplement the behavior yourself and credit the inspiration. Formulas
(Banister, Riegel, VDOT, e1RM) are free to use regardless of the surrounding project's license.

> ⚠️ Licenses above are best-effort reads from the scan and **must be confirmed against each repo's
> `LICENSE` file before you copy anything** — projects relicense, and dual-licensing exists.

---

## Prior art & borrowed features (with attribution)

Features Agon deliberately borrows, the source, the integration mode, and the credit/license
obligation. "Reimplement" = idea only, no code copied. "Port/use" = code or library may be used
directly under a permissive license.

| # | Feature | Source (repo) | License | Mode | Attribution obligation |
|---|---|---|---|---|---|
| 1 | CTL/ATL/TSB + critical-power/W′ formulas | GoldenCheetah / sweatpy | GPL-3.0 (code) | Reimplement formulas in dbt marts; optionally *call* sweatpy as an external lib | Credit sweatpy + Busso/Banister refs in `fct_training_load_daily` doc; do **not** copy GC source |
| 2 | Rate-limit-aware wearable backfill pacing | arpanghosh8453/fitbit-grafana | MIT (verify) | Reimplement pattern for the Fitbit path | Credit in code comment |
| 3 | BLS + OFF + USDA multi-source food resolution | OpenNutriTracker | GPL-3.0 (code); data licenses separate | Reimplement source-selection strategy; use the DBs directly | Credit OpenNutriTracker for the strategy; attribute BLS (CC BY 4.0) + OFF (ODbL) |
| 4 | Historical-log importers (FitNotes/Strong/Hevy CSV) | openGym | verify LICENSE | Reimplement parsers from the public CSV schemas | Credit openGym if parser logic is reused |
| 5 | Progression-rule DSL for `planned_sessions` | Liftosaur (Liftoscript) | AGPL-3.0 | Design-inspiration only — author Agon's own mini-schema | Credit Liftoscript as inspiration; **no code** |
| 6 | Auditable in-code training-load reference | OpenAthlete | verify (TS) | Read as reference before writing marts | Credit if any algorithm is adapted |
| 7 | Normalized multi-provider wearable schema | Open Wearables | MIT | May adapt schema/normalizers directly | Retain MIT notice |
| 8 | Strava streams / FIT parsing | stravalib, python-fitparse, fitdecode, gpxpy | Apache-2.0 / MIT | Use as dependencies | Standard dependency attribution |
| 9 | Race prediction from best efforts (recalibration) | GoldenCheetah, strava-openai-coach | GPL-3.0 / verify | Reimplement; cross-check exponent personalization | Credit in `fct_race_predictions` doc |
| 10 | Conversational-logging UX bar | SparkyFitness (SparkyAI) | verify | UX study only | No obligation (no code) |
| 11 | Food-photo → nutrition estimation (future capture) | nutri-scan / nutri-bot / SparkyFitness | verify | Optional future vision capture mode | Credit if code reused |
| 12 | Smart-scale body-metrics ingestion (future) | openScale | GPL-3.0 | Reimplement export→`body_metrics` ingest | Credit; no code |

**Where to record credit in-repo:** the top-level [`CREDITS.md`](../CREDITS.md) is the authoritative
attribution ledger — it mirrors the table above (each project + license + what was borrowed + a
Planned/Backlog/Shipped status) plus the data-source and policy notes. Add an inline comment at each
borrow site pointing back to its `CREDITS.md` row, and flip the row to **Shipped** with the commit/PR
when the borrow lands. For permissive code actually copied, also retain the original
`LICENSE`/copyright header in the copied file.

---

## Two projects to watch

- **Open Wearables** — the one repo actively growing toward Agon's "unified DB + MCP" lane, with
  more sources and real momentum. If it adds domain analytics + capture, the overlap tightens.
- **SparkyFitness** — the popularity leader for AI-logged self-hosted tracking; sets the UX bar for
  conversational capture even though it stops at daily food/macro logging.

---

*Generated by a 6-agent parallel scan. Full per-slice agent notes are the basis for this document;
star counts are approximate and worth re-checking before citing publicly.*

---
---

# 2026-10-08 — Phone activity recorders (GPS + BLE, screen-off)

**Scan date:** 2026-10-08 · **Mode:** Deep · **Stars captured:** 2026-10-08 (`gh api` for GitHub,
Codeberg API for Codeberg; point-in-time)
**Question:** Agon now records runs/rides itself in a Capacitor Android shell (`app/record`,
`lib/ble/` on `@capacitor-community/bluetooth-le`, `lib/gps/` on
`@capacitor-community/background-geolocation`; design in `.claude/rules/live-recording.md`). Do
existing open-source recorders do this better? Should we adopt one, feed from one, or borrow from
them?
**Checked against Agon's current choices:**
- accept filter: drop fixes with accuracy > 30 m, and jumps > 30 m/s (re-anchor after 3 jumps in a row);
- distance advances only when Doppler speed ≥ 0.5 m/s and the fix is ≥ max(accuracy, 5 m) from the last counted fix;
- distance precedence: typed > GPS > wheel;
- screen-off: samples buffered in WebView IndexedDB, which pauses about 1 min after screen-off (**MZY-280**);
- elevation gain: not computed (open follow-up).

## R1. Method

- **Agents:** 4 parallel agents in four slices: (a) OpenTracks + OsmAnd, (b) FitoTrack, RunnerUp
  and Gadgetbridge, (c) sensor handling and the algorithm/library layer (GoldenCheetah, GPS
  filters, elevation-gain algorithms, background-geolocation and BLE plugins), (d) a gap-filler
  sweep for newer recorders.
- **Code reading:** slices a–c read the **actual source** from shallow clones. Every constant
  below comes from a file path the agents cited.
- **Spot-checks:** the parent re-checked the load-bearing ones against the clones: OpenTracks'
  licence, barometer constants, wake lock, foreground-service (FGS) type and per-point insert;
  OsmAnd's 7 m / 70 % thresholds; FitoTrack's licence and 2.0 m / ±5 constants; RunnerUp's
  backoff; gpx.studio's RDP 20 / 0.1 km window. It also confirmed against
  `node_modules/@capacitor-community/background-geolocation` that the plugin never writes a fix
  to disk.
- **Gaps:**
  - Slice (d) worked mostly from READMEs and search results, and hit the `gh search` rate limit.
  - Nothing was built or run on a device, so all screen-off claims are static readings.
- **Carry-forward:** this section extends the 2026-07-24 scan rather than refreshing it. Prior
  tools in this domain are re-verified below: OpenTracks, Gadgetbridge, GoldenCheetah, gpxpy and
  FitoTrack. Earlier tools outside the recorder domain were not re-scanned, and none was dropped.

**Corrections to the 2026-07-24 scan:**
- **OpenTracks** is **Apache-2.0**, not copyleft. It descends from Google's MyTracks, and its
  `LICENSE` is the Apache 2.0 text. Its live home is Codeberg (142★). The GitHub mirror is
  archived, and its ~1.4k★ is frozen from before the move.
- **Gadgetbridge:** the canonical Codeberg repo has 1,958★. The archived GitHub mirror shows
  4,596★. The earlier "~7k" is unverified.
- **GoldenCheetah:** GitHub reports **GPL-2.0**. `CREDITS.md` rows 1 and 9 say GPL-3.0. Either
  way the reuse rule is the same (copyleft, idea only), but the rows should be corrected. Per this
  task, this scan does not edit `CREDITS.md`.

## R2. Discovery list

Tiers: unknown ≤100★ · niche 101–1k · mildly popular 1k–5k · popular 5k–25k · stellar 25k+.

### Full recorders (phone records GPS + sensors, exports a file)

| Tool | URL | Stars | Tier | Licence | Sensors (GATT) | What it does |
|---|---|---|---|---|---|---|
| **OpenTracks** | https://codeberg.org/OpenTracksApp/OpenTracks | 142 (GH mirror 1,401, archived) | niche | **Apache-2.0** | HR 180D, CSC 1816, power 1818, RSC 1814, BLE barometer 181A, temp, phone barometer | Privacy-first Android sport tracker; the closest analogue to Agon's recorder |
| **FitoTrack** | https://codeberg.org/jannis/FitoTrack | 432 | niche | GPL-3.0 | HR 180D only; phone barometer | Android workout tracker (Room, Nordic BLE lib) with auto-export over HTTP POST |
| **RunnerUp** | https://github.com/jonasoreland/runnerup | 957 | niche | GPL-3.0 | HR 180D (BLE and ANT+); step-sensor cadence; phone barometer | Android run tracker with interval workouts and many sync targets (WebDAV, Endurain, Runalyze, Strava) |
| **OsmAnd** (trip recording + external-sensors plugin) | https://github.com/osmandapp/OsmAnd | 6,062 | popular | GPL-3.0-or-later (API: NOASSERTION) | HR, CSC, power, RSC, temp, BP; ANT+ through a separate app | Offline maps app whose plugin records GPS tracks with sensor data |
| **aTrainingTracker** | https://github.com/rainerblind/aTrainingTracker | 59 | unknown | GPL-3.0 | BLE HR, CSC, RSC; ANT+ HR/CSC/power | Android training tracker revived in 2025. It prefers a speed sensor over GPS speed and auto-detects the sport from the sensors present |
| **Open GPX Tracker** | https://github.com/merlos/iOS-Open-GPX-Tracker | 720 | niche | GPL-3.0 | GPS only | iOS/watchOS GPX logger, the only iOS recorder found |
| **run-track** | https://github.com/sDevPrem/run-track | 100 | unknown | Apache-2.0 | GPS only | Compose + Room demo: a foreground service that survives removal from recents |

### GPS loggers and maps (track only, no training model)

| Tool | URL | Stars | Tier | Licence | What it does |
|---|---|---|---|---|---|
| GPSLogger | https://github.com/mendhak/gpslogger | 2,615 | mildly popular | **unverified** (API NOASSERTION, long known as GPL) | Mature battery-friendly logger with GPX/KML/GeoJSON/CSV output and many auto-upload targets |
| Traccar Client | https://github.com/traccar/traccar-client-android | 761 | niche | Apache-2.0 | Foreground service that pushes fixes to a self-hosted Traccar server |
| Organic Maps | https://github.com/organicmaps/organicmaps | 15,613 | popular | Apache-2.0 | Maps app with track recording to GPX/KML |
| CoMaps | https://github.com/comaps/comaps | 573 | niche | Apache-2.0 | Organic Maps fork |
| Trackbook | https://github.com/y20k/trackbook | 107 | niche | MIT (**archived** 2022) | Minimal GPS track recorder |

### Sensor hubs, bridges, and BLE test tooling

| Tool | URL | Stars | Tier | Licence | What it does |
|---|---|---|---|---|---|
| Gadgetbridge | https://codeberg.org/Freeyourgadget/Gadgetbridge | 1,958 (GH mirror 4,596, archived) | mildly popular | AGPL-3.0 | Watch/band companion. Generic HR-strap logging (experimental), CSC sensor, auto GPX/FIT export of watch workouts, Intent API. It does **not** record phone GPS tracks |
| GoldenCheetah | https://github.com/GoldenCheetah/GoldenCheetah | 2,219 | mildly popular | GPL-2.0 | Desktop analysis/trainer. BLE HR, CP, CSC, FTMS 1826 in `src/Train/BT40Device.cpp` |
| qdomyos-zwift | https://github.com/cagnulein/qdomyos-zwift | 873 | niche | GPL-3.0 | Bridge for 150+ trainers/treadmills that re-exposes FTMS, CP and CSC. A catalogue of device quirks |
| Auuki | https://github.com/dvmarinoff/Auuki | 903 | niche | AGPL-3.0 | Web Bluetooth indoor-trainer PWA (FTMS, CP, HR), the best "BLE in a web stack" precedent. No background mode |
| pizero_bikecomputer | https://github.com/hishizuka/pizero_bikecomputer | 1,278 | mildly popular | GPL-3.0 | Raspberry Pi bike computer with ANT+/BLE HR, CSC and power fused with GPS. Not a phone app |
| CSC_BLE_Bridge | https://github.com/starryalley/CSC_BLE_Bridge | 79 | unknown | MIT | Relays ANT+ CSC/HR sensors to BLE |
| Zwack | https://github.com/paixaop/zwack | 130 | niche | MIT | Simulates a BLE CSC/power peripheral, for testing `lib/bluetoothCycling.ts`/`bluetoothPower.ts` without hardware |
| Gymnasticon | https://github.com/ptx2/gymnasticon | 328 | niche | MIT (stale, 2022) | Bike-to-BLE bridge |
| karoo-ext (+ karoo-ride-replay) | https://github.com/hammerheadnav/karoo-ext | 125 | niche | Apache-2.0 | Karoo extension SDK. ride-replay replays FIT files as mock GPS/sensors (a test-fixture idea) |
| HRAM | https://github.com/AnatoliiChub/HRAM | 8 | unknown | MIT | Kotlin Multiplatform BLE HR recorder |

### Libraries and algorithms

| Tool | URL | Stars | Tier | Licence | Relevance |
|---|---|---|---|---|---|
| @capacitor-community/background-geolocation | https://github.com/capacitor-community/background-geolocation | 250 | niche | MIT | **In use.** Location foreground service. **No native persistence** (see R4) |
| @capacitor-community/bluetooth-le | https://github.com/capacitor-community/bluetooth-le | 359 | niche | MIT | **In use** (MZY-279) |
| Nordic Android-BLE-Library / Kotlin-BLE-Library | https://github.com/NordicSemiconductor/Android-BLE-Library | 2,416 / 528 | mildly popular / niche | BSD-3-Clause | Native BLE foundation, if Agon ever writes its own native sensor service |
| mauron85/react-native-background-geolocation | https://github.com/mauron85/react-native-background-geolocation | 1,354 | mildly popular | Apache-2.0 | The only permissive plugin with **native DB persistence** plus `syncThreshold` batch posting. Its native submodule is stale (2022) |
| mad-location-manager | https://github.com/maddevsio/mad-location-manager | 576 | niche | MIT | Kalman GPS+accelerometer filter, and `GeohashRTFilter` (counts distance only on geohash-cell change). Dormant since 2025-06 |
| kalmanjs / piercus kalman-filter | https://github.com/wouterbulten/kalmanjs · https://github.com/piercus/kalman-filter | 453 / 124 | niche | MIT | Generic JS Kalman filters (not GPS-specific) |
| gpx.studio | https://github.com/gpxstudio/gpx.studio | 1,230 | mildly popular | **MIT** | TS GPX editor. Its elevation-gain algorithm is directly portable (R3.4) |
| gpxpy | https://github.com/tkrajina/gpxpy | 1,108 | mildly popular | Apache-2.0 | `calculate_uphill_downhill`: 3-point kernel, no threshold (noise-prone on phone data) |
| GPXSee | https://github.com/tumic0/GPXSee | 1,247 | mildly popular | GPL-3.0 | Outlier removal by a median-absolute-deviation (MAD) z-score on acceleration, with stop points exempt |
| FitTrackee / Endurain | https://github.com/SamR1/FitTrackee · https://github.com/endurain-project/endurain | 1,173 / 2,238 | mildly popular | AGPL-3.0 | Self-hosted servers that take GPX/TCX/FIT uploads. Peers to Agon's importer, not recorders |

**Not open source — out of scope:**
- **transistorsoft** capacitor/react-native-background-geolocation (143★ / 2,937★): the README
  says "a license is required for RELEASE builds" on Android, and the native library is closed,
  even though the repo `LICENSE` says MIT.
- **Polar BLE SDK** (751★): Polar's proprietary SDK licence, and not needed, because Polar straps
  speak standard 0x180D.
- **Proprietary Play Store apps:** Cadence, IpBike, SuperCycle, Ghostracer, Jepster, WristNav.

**Could not confirm (not listed):** ForRunners (an Ionic/Cordova recorder), SensorDash, and an
"OpenTracks Wear". **No open-source Capacitor/Cordova activity recorder exists** that we could find,
so Agon's stack has no direct precedent.

## R3. Deep profiles

### R3.1 OpenTracks: the reference implementation (Apache-2.0, so the code is reusable)
- **Activity:** very active (commits 2026-10-08). Java, raw `BluetoothGatt`, SQLite via a
  ContentProvider.
- **Sensors:** HR, CSC (wheel and crank), Cycling Power, RSC, a BLE barometer and temperature,
  one driver each in `sensors/driver/*`.
  - Reconnect is a bare `gatt.connect()` on disconnect, with no backoff.
  - FTMS: not found.
- **Screen-off (the best of the field):**
  - `TrackRecordingService` declares `foregroundServiceType="location|connectedDevice"`
    (`AndroidManifest.xml:423`).
  - A **PARTIAL_WAKE_LOCK** is held for the whole recording (`util/SystemUtils.java:76-95`,
    acquired in `SensorManager.start`).
  - Every stored trackpoint is **inserted into SQLite on the spot**
    (`TrackRecordingManager.insertTrackPoint`). Only the single pending sub-interval fix lives in
    memory.
  - `START_STICKY` plus `TrackIdStorage` (the active track id in SharedPreferences) resume the
    track after the OS kills and restarts the service.
  - No battery-optimisation prompt.
- **GPS filter:**
  - Accuracy gate default **50 m**, user-selectable from 10 to 2,000 m.
  - Recording distance interval **10 m** (1–100 m): a fix is stored only when it is ≥ 10 m from
    the last stored one.
  - A jump > **200 m** starts a new segment instead of adding distance. There is no m/s test.
  - No smoothing or Kalman filter. It requests `GPS_PROVIDER` at `QUALITY_HIGH_ACCURACY`.
- **Distance:**
  - Haversine between stored points, or `sensorDistance` (the wheel/foot-pod delta) when a
    sensor reports one, so **sensor beats GPS**.
  - Idle is displacement-based: no stored point for 10 s means idle.
  - Doppler speed is not used.
- **Elevation gain: barometer only.**
  - Pressure is sampled every 5 s and exponentially smoothed with α = 0.3, then converted with
    `SensorManager.getAltitude`.
  - A **3.0 m staircase** (`ALTITUDE_CHANGE_DIFF_M`) emits ±3 m steps, so sub-3 m wobble never
    accumulates.
  - Gain and loss are stored per trackpoint.
  - There is no GPS-altitude gain fallback.
  - EGM2008 geoid correction is applied through androidx `core-location-altitude`
    (`AltitudeConverterCompat`) on the live path. Whether the stored altitude is corrected is
    unverified.
- **Export:**
  - Formats: KMZ (default), KML, GPX, CSV. No FIT or TCX.
  - GPX extensions:
    - `gpxtpx` = Garmin **TrackPointExtension v2** (`hr`, `cad`, `speed`, `atemp`);
    - `pwr:PowerInWatts`;
    - `opentracks:gain`, `opentracks:loss`, `opentracks:distance`, `opentracks:accuracy_horizontal`.
  - Optional **post-workout auto-export** to a folder chosen in the Android file picker (Storage
    Access Framework, SAF), plus Health Connect export.
  - A read-only, opt-in Dashboard Intent API.

### R3.2 FitoTrack (GPL-3.0, idea only)
- **Activity:** active (2026-09). Kotlin, Room, Nordic BLE library. HR only.
- **Screen-off:**
  - FGS type `location|health`, PARTIAL_WAKE_LOCK `acquire(4h)`, `START_STICKY`.
  - **Every GPS and HR sample goes into Room synchronously.**
  - On restart, `findRunningWorkout()` resumes the open workout, and app start restarts the service
    if a workout is still running.
  - This is the cleanest "nothing lost on process death" design in the slice.
- **GPS filter:** no accuracy drop at all (30 m is only a UI badge). A per-sport minimum distance
  (run 5 m, bike 10 m) and a 500 ms minimum time gap. Auto-pause after 10 s with no stored sample.
- **Distance:** computed at finalize time (Vincenty over stored samples), not live.
- **Elevation, post-hoc:**
  - The barometer gives the shape, anchored to the mean GPS altitude; otherwise GPS is used as is.
  - Bundled geoid table.
  - ±7 moving average, then a ±5 average, then a **2.0 m floating hysteresis band** for ascent and
    descent (`data/CalculatedValues.kt:36-90`).
- **Export:** GPX (`gpxtpx` v1, HR only) and **HTTP POST auto-export** of each finished workout
  (WorkManager, waits for network). The most direct push path into a self-hosted endpoint.

### R3.3 RunnerUp (GPL-3.0, idea only)
- **Activity:** active (2026-10). Raw `BluetoothGatt` HR plus ANT+ (in a non-free build flavour).
- **Reconnect is the best found** (`RetryingHRProviderProxy.java`): exponential backoff
  `(1 << attempt) * 1000` ms, gives up after 10 attempts, and resets the counter after 30 s of
  stable connection.
- **Screen-off:** FGS `location|health`, `START_STICKY`, a per-fix SQLite insert
  (`PersistentGpsLoggerListener`). But the wake lock is only 5 min and there is no resume logic.
  Data survives a process death, but the run does not continue.
- **GPS:** **raw summation of every fix**, with no accuracy, jump or minimum-distance guard. Speed
  is Doppler (low-pass α 0.4). Auto-pause is speed-based.
- **Elevation:** barometer offset locked to a 60 s low-pass of GPS altitude, plus MSL correction
  via `core-location-altitude`. It stores per-point altitude only, **no gain total**.
- **Export:** GPX (TPX v2), TCX, and sync to File, WebDAV, Dropbox, Endurain, Runalyze and Strava.

### R3.4 OsmAnd trip recording (GPL-3.0+, idea only)
- **Screen-off:**
  - `NavigationService` with FGS `location` only, and no CPU wake lock found.
  - **A battery-optimisation exemption dialog** (`BatteryOptimizationController`), the only app
    in the slice that asks.
  - A per-fix SQLite INSERT (`SavingTrackHelper`), rebuilt into a GPX file at app start if the
    last point is more than 30 min old.
- **Record gate:**
  - Interval 5 s (10 s pedestrian).
  - Accuracy ≤ **50 m**.
  - Minimum distance and minimum speed both off by default.
  - No jump guard.
- **External-sensors plugin:** BLE HR, CSC, CP, RSC. Reconnect retries every 5 s, with a 30 s
  timeout. The user picks which device feeds each data type.
- **Elevation gain, offline and GPS-only (the best GPS-only algorithm found):**
  - (1) keep local turning points;
  - (2) drop points whose slope exceeds **70 %**;
  - (3) recursive Douglas-Peucker-style extremum selection in (distance, elevation) space with a
    **7 m** threshold, summing up/down between the extrema
    (`OsmAnd-shared/.../gpx/ElevationApproximator.kt`, `ElevationDiffsCalculator.kt`).
- **Export:** GPX with `gpxtpx` **v1** (`hr`, `cad`, `power`). Also live HTTP monitoring to a
  configurable URL (payload format unverified).

### R3.5 gpx.studio (MIT, so the code is reusable): elevation gain without a barometer
`gpx/src/gpx.ts::_elevationComputation` (L985-1040), in two stages:
1. Ramer-Douglas-Peucker simplification of the distance-vs-elevation curve with **ε = 20**.
2. Within each segment, a **distance-window moving average of 0.1 km (100 m)**.

It then sums the positive deltas. The window is distance-based, so it is robust to pace changes and
GPS sample rate. It is pure TypeScript with no dependencies, so it is the cheapest correct path to
`elevation_gain_m`.

### R3.6 GoldenCheetah (GPL-2.0, idea only): sensor decoding and the gain convention
- **BLE decoding** (`src/Train/BT40Device.cpp`):
  - HR, CP, CSC and FTMS decoding.
  - uint16 rollover via `+0x10000`.
  - A wheel time base of **1/2048 s for power meters vs 1/1024 s for CSC** (Agon already handles
    this).
  - Discards the first sample after connect.
  - A **staleness counter** that holds cadence for 2 unchanged notifications, then reports 0, so
    < 60 rpm still reads correctly at 1 Hz.
- **Elevation gain** (`BasicRideMetrics.cpp`): a ratchet with hysteresis **3.0 m** by default
  (`GC_ELEVATION_HYSTERESIS`), on raw altitude. The same 3 m that OpenTracks arrived at
  independently.

### R3.7 Gadgetbridge (AGPL-3.0, idea only): a feed, not a recorder
- Generic HR-strap logging, plus CSC with rate-limited DB persistence (live broadcast, DB write
  every 60 s).
- **It records no phone GPS track.**
- Its value for Agon is as a source: auto GPX/FIT export of **watch** workouts to a folder, plus an
  opt-in Intent API (`TRIGGER_EXPORT`), plus a native Endurain uploader. It also drives OpenTracks
  through OpenTracks' API.

## R4. Agon vs the field, capability by capability

| Capability | Agon today | Best in field | Verdict |
|---|---|---|---|
| **Durable screen-off buffering** (MZY-280) | Fix arrives in the plugin service → `LocalBroadcastManager` → JS callback → IndexedDB write, which **queues in memory** once the WebView is hidden. A process death loses the queue. Confirmed: the plugin's `BackgroundGeolocationService.java` never writes to disk (its README lists persistence as a TODO, issue #137) | OpenTracks, FitoTrack, RunnerUp and OsmAnd all **INSERT each sample into SQLite inside the foreground service**. OpenTracks and FitoTrack also resume via `START_STICKY` plus a stored active-recording id | **Agon is behind every native recorder.** The only real gap that matters |
| Wake lock / FGS type | Plugin FGS `location` only, no explicit wake lock | OpenTracks: `location\|connectedDevice` plus a recording-long PARTIAL_WAKE_LOCK. FitoTrack: 4 h lock | Behind. Cheap to fix |
| Battery-optimisation exemption | none | OsmAnd's one-time dialog | Behind. Cheap to fix |
| Accuracy gate | 30 m | OpenTracks and OsmAnd 50 m. FitoTrack and RunnerUp none | **Agon is stricter. Keep it** |
| Jump guard | > 30 m/s, re-anchor after 3 | OpenTracks 200 m segment break. Others none. GPXSee MAD z-score (post-hoc) | **Agon is better than every recorder.** A GPXSee-style post-hoc pass is optional |
| Stationary jitter | Doppler ≥ 0.5 m/s plus ≥ max(acc, 5 m) anchor | OpenTracks 10 m interval. FitoTrack 5/10 m. mad-location `GeohashRTFilter` | **Agon is at least as principled.** Watch for under-counting on twisty routes (the anchor cuts corners, as all of these do) |
| Distance precedence | typed > GPS > wheel | OpenTracks and aTrainingTracker: **sensor > GPS** | A deliberate divergence (the athlete chose GPS). Field consensus favours the wheel, worth one A/B on a real ride before standing by it |
| **Elevation gain** | null | Barometer: OpenTracks' EMA 0.3 plus 3 m staircase. GPS-only: gpx.studio's RDP 20 plus a 100 m window (MIT), or OsmAnd's 70 % slope cut plus 7 m extrema | **Behind, and easily closed.** Build it in TS from `run_streams.altitude_m` |
| Geoid (WGS84 → MSL) | raw ellipsoid altitude | `androidx.core:core-location-altitude` (OpenTracks, RunnerUp) | Irrelevant to gain (the offset cancels). Only needed if absolute altitude is displayed |
| BLE reconnect | per `heartRateLink.ts` | RunnerUp's exponential backoff (1 s·2ⁿ, give up after 10, reset after 30 s stable) | Borrow the policy if field drops show up |
| Sensor coverage | HR, CSC, CP | OpenTracks adds RSC (foot pod) and a BLE/phone barometer. GC and qdomyos add FTMS | RSC and barometer are the only plausible adds |
| Export / interop | Postgres via flush. No export | OpenTracks GPX (TPX v2 + power + gain), FitoTrack HTTP POST, RunnerUp WebDAV, Gadgetbridge GPX/FIT auto-export | n/a. Agon is the sink, not a source |

## R5. Could an existing recorder feed Agon instead of, or alongside, ours?

**OpenTracks is the only credible full replacement.** It is permissive, maintained, covers all
three GATT services plus RSC and barometer, and already solves durable buffering and elevation
gain. Pipeline: post-workout auto-export of GPX → a Syncthing-synced folder → the tower → Agon's
file importer.

Cost on Agon's side:
- The GPX parser (`services/fileImport/gpx.ts`) already reads prefix-agnostic `hr`, `cad` and
  `speed`, so TPX v2 works today.
- It **drops** `pwr:PowerInWatts`, `opentracks:distance` and `opentracks:gain`.
- The importer CLI is **run-only**; the generic ride importer gap is already noted in
  `live-recording.md`.

**What we would lose by switching:**
- per-sample device provenance (MZY-271), the primary-device rule and the conflict alert;
- the Doppler/jump filter;
- the `(source, external_id)` idempotent flush right after Stop (export is post-stop and
  file-based, so ingest latency depends on sync);
- planned-session context in the recorder, and one app for capture and review.

FitoTrack's HTTP POST export (straight to an Agon endpoint) and Gadgetbridge's watch-workout
GPX/FIT export are viable **alongside** feeds. Neither replaces the recorder: FitoTrack is HR-only,
and Gadgetbridge records no phone GPS.

## R6. Verdict — build vs adopt per capability

- **Keep building the recorder (moat-adjacent, already shipped):** BLE sensor model with provenance,
  accept/jump/stationary filtering (Agon is ahead of the field here), distance precedence and the
  idempotent flush. Nothing in the field is better enough to justify a switch.
- **Durable screen-off buffering (MZY-280): build natively, borrowing the OpenTracks/FitoTrack
  pattern.** No open-source Capacitor plugin persists fixes. The candidate options, smallest first:
  1. **An in-repo native journal plugin**, next to `AgonNotifications`. Its `append(sample)` writes
     a line to an app-private append-only file (or SQLite) synchronously. Plugin callbacks still
     run while the WebView is hidden (MZY-273 spike), so the JS BLE/GPS handlers could call it
     instead of relying on IndexedDB alone. On resume, or on the "unfinished recordings" list,
     replay the journal into IndexedDB.
     - Covers BLE and GPS with one seam.
     - **Hypothesis to verify on device:** that bridge *calls* still go through while the
       WebView's timers are paused.
  2. Patch or fork `@capacitor-community/background-geolocation` (MIT) so that
     `BackgroundGeolocationService` writes each fix to disk before broadcasting, with a
     `drain()` method. This fixes GPS even if JS is fully stalled, but leaves BLE samples
     uncovered.
  3. A full native recorder service (FGS `location|connectedDevice`, native BLE through Nordic's
     BSD-3 library, SQLite, `START_STICKY` plus a stored active-recording id). This is the
     OpenTracks architecture: the most robust, and the most code.

  Whichever is chosen, also borrow the cheap wins: a recording-long PARTIAL_WAKE_LOCK, adding
  `connectedDevice` to the FGS type, and a one-time battery-optimisation exemption prompt
  (OsmAnd).
- **GPS elevation gain: build it, porting gpx.studio's MIT algorithm.**
  - Add RDP ε 20 plus a 100 m distance-window average as a pure TS function, applied at flush to
    the stored `altitude_m`. Also apply it as a backfill over existing `run_streams`, which would
    give Strava/Google Health imports without a gain value the same treatment.
  - Optionally add a ≥ 3 m hysteresis on the smoothed series, the GC/OpenTracks convention.
  - Cross-check against OsmAnd's 7 m extrema method (idea only) on a few known routes.
  - Barometer gain is a later upgrade. It needs a pressure-sensor plugin, which OpenTracks'
    Apache-2.0 `PressureSensorUtils`/`BarometerInternal` could be ported into, and only applies if
    the phone has a barometer.
- **Adopt as feeds (alongside, not instead):**
  - Teach the GPX importer `PowerInWatts`/`gpxtpx:power` and the ride path. Then OpenTracks,
    Gadgetbridge (watch workouts) and RunnerUp exports all import cleanly, which is a cheap
    fallback if the recorder ever fails mid-run.
  - Optional: a FIT parser, for Gadgetbridge's FIT export.
- **Don't adopt:** transistorsoft (closed Android release licence), Polar SDK (proprietary,
  unneeded), Kalman/accelerometer fusion (mad-location-manager, too heavy for the gain over Agon's
  current filter).
- **Test tooling worth adopting:** Zwack (MIT) to simulate CSC and power peripherals. Power support
  (MZY-270) is still unverified on real hardware.

**Projects to watch:**
- **OpenTracks:** active, permissive, and the de-facto reference.
- **aTrainingTracker:** revived in 2025, with sensor-priority logic close to Agon's model.
- **@capacitor-community/background-geolocation:** if its persistence TODO (#137) lands, option 2
  above becomes free.

## R7. Proposed CREDITS rows (not yet written to `CREDITS.md`)

| Borrow | Source | Licence | Reuse mode | Obligation | Status |
|---|---|---|---|---|---|
| GPS elevation gain (RDP ε 20 plus a 100 m distance window) | gpxstudio/gpx.studio | MIT | Code port | Keep the MIT notice in the ported file, plus a CREDITS row | Proposed |
| 3 m elevation hysteresis convention | GoldenCheetah (`BasicRideMetrics.cpp`), OpenTracks | GPL-2.0 / Apache-2.0 | Idea / constant | Inline credit comment | Proposed |
| Barometer gain (EMA 0.3, 3 m staircase) | OpenTracksApp/OpenTracks (`PressureSensorUtils.java`) | Apache-2.0 | Code port (future native plugin) | Keep the Apache header and NOTICE, state changes | Proposed (later) |
| Native per-sample journal plus `START_STICKY` resume via a stored active id | OpenTracks (Apache-2.0); FitoTrack (GPL-3.0) | Apache-2.0 / GPL-3.0 | Reimplement (FitoTrack idea only; OpenTracks code may be adapted) | Credit comment, plus the Apache notice if any OpenTracks code is copied | Proposed (MZY-280) |
| Recording-long PARTIAL_WAKE_LOCK, FGS `location\|connectedDevice` | OpenTracks | Apache-2.0 | Pattern | Credit comment | Proposed |
| Battery-optimisation exemption prompt | OsmAnd (`BatteryOptimizationController`) | GPL-3.0+ | Idea only | Credit comment, no code | Proposed |
| HR reconnect backoff (1 s·2ⁿ, give up after 10, reset after 30 s) | jonasoreland/runnerup (`RetryingHRProviderProxy`) | GPL-3.0 | Idea only | Credit comment, no code | Proposed (if needed) |
| CSC cadence staleness counter (hold 2 notifications, then 0) | GoldenCheetah (`BT40Device.cpp`) | GPL-2.0 | Idea only | Credit comment | Proposed (if needed) |
| OpenTracks/Gadgetbridge GPX extension coverage in the importer | OpenTracks / Gadgetbridge export formats | n/a (format interop, no code) | Interop | None | Proposed |
| CSC/CP peripheral simulator for tests | paixaop/zwack | MIT | Dev dependency | Standard dependency attribution | Proposed |

Also fix the existing `CREDITS.md` rows 1 and 9: GoldenCheetah is GPL-2.0 per GitHub, not GPL-3.0.

## R8. Provenance & limitations

- Point-in-time (2026-10-08). The star counts for Codeberg-hosted projects (OpenTracks, FitoTrack,
  Gadgetbridge) are Codeberg's own and are not comparable to GitHub's, since migrations left large
  frozen counts on the archived GitHub mirrors.
- All code facts come from reading the source, not from running anything. No screen-off behaviour
  was tested on a device, including Agon's own option 1 hypothesis.
- **Unverified:**
  - GPSLogger's licence (no SPDX);
  - whether OpenTracks stores EGM2008-corrected altitude;
  - OsmAnd's live-monitoring payload;
  - OSMDashboard's licence;
  - whether RunnerUp re-acquires its wake lock elsewhere;
  - the gap-filler tools' background behaviour (README-level only).
- Slice (d) hit the GitHub search rate limit, so the "newer recorders" sweep is not exhaustive.
