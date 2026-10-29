# analytics/ — dbt + Lightdash (Phase 3)

Reserved for the dbt project and Lightdash config. Per CLAUDE.md this is built
only **after 2–3 weeks of clean data** are in Postgres, so it is intentionally
empty at the data-backbone milestone — the directory exists to fix ownership and
the least-privilege warehouse roles it will use.

Those roles are already created by the migration
`migrations/20260723001000_analytics_roles.sql`:

- **`dbt_writer`** — reads whitelisted source tables, owns the `analytics`
  schema. dbt runs as this role; CI never holds a superuser credential.
- **`lightdash_reader`** — `SELECT` on `analytics` only. Lightdash connects as
  this role.

**Starter scaffold (present now):**

- `profiles.yml` — env-var-driven connection profile (`agon_analytics`), wired to
  the `DBT_*` vars set by the containerized dbt service. Runs as `dbt_writer`;
  `sslmode` defaults to `disable` for the local no-SSL stack.
- `dbt_project.yml` — minimal project stub (staging → views, marts → tables).
  `dbt parse` / `dbt debug` work now; `dbt build` is a no-op until models land.

Run dbt without a host-side Python venv — the pinned container IS the environment.
Simplest local path is the `analytics/dbt.sh` wrapper (also `pnpm dbt <args>`),
which passes any subcommand through to dbt against the local `agon-db` Postgres as
`dbt_writer`:

```
pnpm dbt parse            # compile-only (no DB needed)
pnpm dbt build            # seed + run + test
pnpm dbt run --select fct_relative_effort
```

One-time local setup (dbt_writer has no password by default — peer auth):

```
docker compose --env-file .env.local exec db psql -U agon -d agon -c "ALTER ROLE dbt_writer LOGIN PASSWORD 'dbtlocal';"
```

`dbtlocal` is for a throwaway dev database. On a machine you rely on, pick your
own password, set the same value as `DBT_WRITER_PASSWORD` in `.env.local`, and
never commit it.

**Linux with the native Docker engine:** the database is published on
`127.0.0.1:5432` only, and the bridge route the wrapper uses by default
(`host.docker.internal`) is refused with "Connection refused". Set
`DBT_DOCKER_NETWORK=host` in `.env.local` and the container shares the host's
network instead, so `127.0.0.1` works. Leave it unset on Docker Desktop
(macOS, Windows). `pnpm data:freshness` is the first thing that needs this
on a tower.

On the tower, use the compose `dbt` profile (env-driven, same image) instead:

```
docker compose --env-file .env.local --profile analytics run --rm dbt build
```

**Landed (2026-08-05, Strava-premium benchmark — see `docs/strava-benchmark.md`):**
the first real models, ahead of the full Phase 3 push because the best-efforts
reference data is complete now (not gated on 2–3 weeks of clean data):

- `models/staging/_sources.yml` — `agon_raw` source (`public.strava_best_efforts`).
- `models/staging/stg_strava_best_efforts.sql` (view) — adds derived pace.
- `models/marts/fct_run_best_efforts.sql` (table) — per-distance PRs; input to the
  future `fct_race_predictions` (Riegel-exponent recalibration).
- `seeds/strava_web_reference.csv` — manually-captured Strava Fitness & Freshness
  (CTL/ATL/TSB) reference points, for validating `fct_training_load_daily` later.

Verified with a full containerized `dbt build` (15/15 PASS).

**Still to add when Phase 3 lands:** the remaining `fct_*` marts listed in
CLAUDE.md (`fct_training_load_daily`, `fct_lift_progression`,
`fct_run_compliance_weekly`, `fct_nutrition_vs_targets`, `fct_body_comp_trend`,
`fct_race_predictions`, `fct_run_fueling` — built, with sibling `fct_ride_fueling`). Mirror the sihha `analytics/` layout.
