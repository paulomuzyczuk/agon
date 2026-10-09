# Strava Premium Benchmark (2026-08-05)

A one-time, time-boxed benchmark run while a **gifted month of Strava premium**
had reopened API access (the 2026-06-30 paywall is per-developer-subscription).
Goal: use Strava's paywalled features as ground truth for Agon's premium-parity
reimplementations, and pull reference data that becomes unavailable once premium
lapses. **Strava is NOT a live source** — nothing here touches `/sync`, cron, or
any steady-state path (see CLAUDE.md "Run Ingestion Pivot").

Three targets, in priority order. Summary of what each turned out to be:

| # | Target | Strava API? | Outcome |
|---|--------|-------------|---------|
| 1 | Best efforts | ✅ Yes (`best_efforts[]` on detailed activity) | **Pulled + stored + modeled in dbt.** |
| 2 | Race predictions | ❌ No — **feature does not exist on Strava at all** | Nothing to capture; Agon's Riegel/VDOT is net-new. |
| 3 | Fitness & Freshness | ❌ No (web-only) | **Captured 4 reference points → dbt seed.** |

---

## 1 — Best efforts (per-distance PRs)

**API-available.** The detailed-activity endpoint
(`GET /activities/{id}?include_all_efforts=true`) returns a `best_efforts[]`
array for each run — the best split at every standard distance *within* that
activity. There is no all-time-PR endpoint, so we pull every activity's efforts
and derive the PR (fastest split) per distance.

Pulled **352 effort rows across 52 run activities** into
`public.strava_best_efforts`; the PR rollup is the dbt mart
`analytics.fct_run_best_efforts` (one row per distance):

(The PR table itself is the athlete's own data and is not reproduced here;
run the dry run below against your own account to see yours.)

These are the **best-effort pairs** needed to recalibrate the Riegel exponent to
the athlete's own physiology — the part CLAUDE.md's PR-prediction feature
(Premium-Parity #2) says Strava can't do transparently. `fct_run_best_efforts` is
the intended input to a future `fct_race_predictions` mart.

**Re-run (while premium lasts):**
```
pnpm strava:best-efforts            # dry run — prints the PR table
pnpm strava:best-efforts --write    # persist (resumable; 429-safe)
pnpm strava:best-efforts --refresh  # re-fetch activities already stored
```
Rate limit: ~100 detail calls / 15 min. A full pull of ~56 activities takes two
passes (stop on 429, re-run to resume).

## 2 — Race predictions

**Strava has no race-prediction feature — web or API.** Verified in the
premium Training menu (Aug 2026): the subscription features are Training Log,
Training Plans, Power Curve, and Fitness & Freshness. There is no predicted-race-
times view anywhere. (Race-time prediction is a Garmin/COROS feature, not Strava.)

So there is **no Strava ground truth to cross-check** against Agon's planned
`fct_race_predictions`. This reframes the feature: Agon's Riegel/VDOT predictor
isn't matching a Strava number — it's **something Strava doesn't offer at all**
(a genuine premium-parity win). Its input is target #1's best efforts. No browser
capture needed.

**Built (2026-08-08).** `fct_race_predictions` (`lib/racePrediction.ts` →
`public.race_predictions`): headline is a Riegel power law with the exponent
recalibrated from the athlete's own best-effort pairs (log-log fit; for this
athlete the fitted exponent came out well above the generic 1.06, i.e. a harder
fade with distance), with Daniels VDOT + generic-k Riegel as cross-check
columns. The reference VDOT reads below a lab/watch VO2max estimate because
these best efforts are fastest splits *within training runs*, not all-out
races — so the numbers are "current sustained fitness," not race ceiling. 70k
is a labeled extrapolation with wide bands. No Strava ground truth exists, by
construction.

## 3 — Fitness & Freshness (CTL / ATL / TSB)

**Web-only** (`strava.com/athlete/fitness`), no API endpoint (community-confirmed).
Captured manually from the web page: the four headline values (Fitness, Fatigue,
Form, and the 6-month Fitness peak), mapped to CTL / ATL / TSB analogs and
stored as the dbt seed `analytics.strava_web_reference`
(`analytics/seeds/strava_web_reference.csv`). The committed seed holds
**illustrative values** — replace them with your own capture.

**Caveat for validation:** Strava's model is **Relative-Effort / HR based** (no
power meter), and its units are Strava's own — **not** directly comparable in
*absolute magnitude* to a Banister TRIMP-based CTL. When Agon's
`fct_training_load_daily` exists, validate the **shape/trend and the sign of TSB**
against these points, not the raw numbers. To refresh, re-read the page and update
the seed CSV.

**Validation result (2026-08-08).** `fct_training_load_daily` is built
(`lib/trainingLoad.ts` → `public.training_load_daily`, CTL 42d / ATL 7d / TSB =
CTL − ATL prev-day). On the reference capture date the model matched Strava's
**TSB sign and fatigued shape (ATL > CTL)**, which is what the caveat above says
to validate.

**HR-gap remediation (supersedes the first comparison).** A near-exact CTL match
on the first pass turned out to be a shared artifact: a month of runs had **no
heart-rate data** (a chest-strap failure), so every run in it scored 0 TRIMP and
CTL faked a taper during peak training. **Strava's own Fitness curve is HR-based
too, so it shares the same hole** — two systems making the same omission, not
two systems being right.

Two fixes closed the gap (both leave stream-scored runs untouched):

1. **Manual average-HR estimates** for runs the athlete estimated by feel,
   imported via `scripts/import-manual-hr.ts` (COALESCE-only,
   `method='average'`, provenance-stamped).
2. **A pace→HR load surrogate** (`method='estimated_pace'`) for runs with *no*
   HR at all: an average HR is inferred from the run's pace via a linear model
   fit to the athlete's OWN measured (pace, HR) runs (junk sub-120-bpm dropout
   averages and walks are filtered before fitting), clamped to the athlete's HR
   reserve. Pure logic + tests in `lib/relativeEffort.ts`; constraint widened by
   migration `20260808030000_run_relative_effort_estimated_pace.sql`.

After both, every run is scored and CTL builds continuously instead of
cratering. Agon's CTL now runs *above* Strava's **by design** — it counts
training (via estimates) that Strava's HR-gated curve cannot — while TSB sign
and fatigued shape still match.

---

## Verification

- `services/strava/bestEfforts.ts` — unit-tested (`__tests__/strava/bestEfforts.test.ts`, 8 tests): fetch parsing, 429/404, pure PR rollup.
- `fct_run_best_efforts` logic checked against the stored rows via MCP `run_sql` (correct fastest split per distance).
- **`dbt build` green end-to-end** against the local DB: 1 seed + `stg_strava_best_efforts` (view) + `fct_run_best_efforts` (table) + 12 data tests, 15/15 PASS. This is the analytics project's first real dbt model set (previously a stub).

### Local dbt note
`dbt` runs containerized (`ghcr.io/dbt-labs/dbt-postgres:1.9.0`, no host install).
To build locally the `dbt_writer` role needs a password (the migration creates it
without one for peer auth); a throwaway `dbtlocal` password was set on the local
`agon-db` for this run:
```
docker compose --env-file .env.local exec db psql -U agon -d agon -c "ALTER ROLE dbt_writer LOGIN PASSWORD 'dbtlocal';"
docker run --rm --platform linux/amd64 --add-host=host.docker.internal:host-gateway \
  -v "$PWD/analytics":/usr/app -w /usr/app -e DBT_PROFILES_DIR=/usr/app \
  -e DBT_HOST=host.docker.internal -e DBT_USER=dbt_writer -e DBT_PASSWORD=dbtlocal \
  -e DBT_DBNAME=agon -e DBT_SCHEMA=analytics -e DBT_SSLMODE=disable \
  ghcr.io/dbt-labs/dbt-postgres:1.9.0 build
```
On the tower, `DBT_WRITER_PASSWORD` is set out of band per `docker-compose.yml`.
