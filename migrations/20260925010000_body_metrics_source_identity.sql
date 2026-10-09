-- Google Health weight/body-fat sync (MZY-216). body_metrics was manual-only
-- (Telegram /weight + /bf, body voice notes); the athlete actually logs weight
-- in Google Health (Fitbit app + Health Connect/Polar Flow), which the wellness
-- sync never pulled. Give synced rows the same source-agnostic identity every
-- other ingested table uses — (source, external_id) — so `pnpm gh:wellness`
-- upserts idempotently.
--
-- Manual rows keep source/external_id NULL; the unique index is PARTIAL so any
-- number of them can coexist (still no UNIQUE(date) — morning/evening weigh-ins
-- on the same day remain allowed).
--
-- EXPAND phase only: two nullable columns + a partial index, nothing destroyed.
ALTER TABLE public.body_metrics
  ADD COLUMN source      TEXT,
  ADD COLUMN external_id TEXT;

CREATE UNIQUE INDEX uq_body_metrics_source_external_id
  ON public.body_metrics (source, external_id)
  WHERE external_id IS NOT NULL;
