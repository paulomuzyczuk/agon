-- Idempotent-upsert key for lab_panel_results, mirroring sihha's
-- psychometric_results design (public repo:
-- supabase/migrations/20260714040000_psychometric_results.sql), which keys
-- test results on a natural (recipient_id, test_date, instrument, measure)
-- tuple so a corrected CSV re-import upserts in place instead of duplicating.
-- Agon's equivalent natural key is (lab_panel_id, marker) — the panel row
-- already scopes date + panel_type, so the marker alone disambiguates within
-- it. Needed for scripts/import-lab-results.ts (the CSV importer mirroring
-- sihha's scripts/import-psychometrics.ts).
--
-- source_file mirrors psychometric_results.source_file: provenance of which
-- report a value came from, entered per-result rather than via a separate
-- document/storage table — Agon deliberately doesn't mirror sihha's
-- Supabase-Storage-backed `evaluations` table (CLAUDE.md already decided
-- against `@supabase/supabase-js` / Storage; Agon's DB access is plain `pg`
-- against a DATABASE_URL). A free-text path/filename is enough provenance for
-- a single-user, self-hosted app with no signed-URL/RLS surface to build.

ALTER TABLE public.lab_panel_results ADD COLUMN source_file TEXT;

ALTER TABLE public.lab_panel_results
  ADD CONSTRAINT lab_panel_results_panel_marker_key UNIQUE (lab_panel_id, marker);

COMMENT ON COLUMN public.lab_panel_results.source_file IS
  'Provenance: the report file (path/filename) this value was read from, if imported. Mirrors sihha psychometric_results.source_file.';
