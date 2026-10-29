---
paths:
  - "analytics/**"
  - "scripts/check-data-freshness.ts"
  - "scripts/*backfill*.ts"
  - "deploy/agon-freshness.service"
  - "deploy/agon-freshness.timer"
---

# Analytics Stack — dbt + Lightdash

Full build/verification narrative: tracked in Linear.

- dbt project in `analytics/` with env-var `profiles.yml` (incl. `sslmode`
  for the no-SSL local stack), `stg_*` staging models over raw ingestion
  tables, `fct_*` marts + metrics in `marts.yml`.
- **Marts**: `fct_training_load_daily` (ATL/CTL/TSB), `fct_lift_progression`
  (deferred — 0 rows in `lifting_sets`), `fct_run_compliance_weekly`
  (easy-run HR zone compliance vs. block targets), `fct_nutrition_vs_targets`
  (deferred — needs the Cronometer import), `fct_body_comp_trend`,
  `fct_race_predictions`, `fct_relative_effort`, `fct_run_fueling` +
  `fct_ride_fueling` (MZY-64), `fct_ride_power` (MZY-267: summary watts/kJ
  + `power_source`/`is_measured`; filter `is_measured` before treating
  watts as data — power never feeds training load; MZY-269 adds Agon's
  `np_w`/`intensity_factor`/`tss`/`ftp_w` and `zone1_s..zone7_s` (MZY-63) from
  `stg_ride_power_metrics`,
  measured streams only), `fct_ride_power_curve` (MZY-269: one row per
  ride × mean-max duration; season-best = group by `duration_s`
  max(`watts`) in Lightdash). Phase 4 correlation marts
  join these once they're all live in production.
- Least-privilege warehouse roles: `dbt_writer` (read whitelisted sources,
  owns `analytics` schema) and `lightdash_reader` (SELECT on `analytics`
  only). CI never holds the superuser credential.
- **`dbt source freshness` is the ingestion dead-man's switch**
  (`analytics/models/staging/_sources.yml`). Per-table `freshness` +
  `loaded_at_field: created_at` — NOT `updated_at`, because enrichment
  passes bump `updated_at` and would mask a table receiving no NEW rows.
  ERROR only on `runs` (72h/168h) and `daily_activity` (48h/120h — the
  sharpest signal, resting HR lands whether or not the athlete trained);
  WARN-only on sparser tables (`hrv_daily`, `sleep_sessions`, derived marts
  — stale there just means a backfill wasn't re-run). `pnpm data:freshness`
  messages Telegram (`TELEGRAM_OWNER_CHAT_ID`) and exits non-zero on error
  OR when the check itself couldn't run — "unverified" must never read as
  "healthy" (a real bug here is documented in Linear: a bad `DBT_HOST` made
  dbt fail while the check read the PREVIOUS run's artifact and reported
  all-fresh; fixed by deleting the artifact before every run). Scheduled
  nightly via `deploy/agon-freshness.{service,timer}` (08:00,
  `Persistent=true`) rather than GitHub Actions — no CI, self-hosted stack.
  Activation on the real tower is tracked in Linear (MZY-27).
- dbt CI lane on PRs touching `analytics/**` or migrations: `dbt parse`
  fast-fail, then full build against a from-scratch local stack as
  `dbt_writer`.
