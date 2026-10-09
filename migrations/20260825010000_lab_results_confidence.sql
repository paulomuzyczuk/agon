-- Extraction provenance for lab_panel_results, mirroring sihha's lab_results
-- confidence/needs_review/model columns (public info gathered from the
-- private ~/projects/sihha repo: supabase/migrations/20260716020000_lab_documents.sql
-- + .claude/skills/lab-ingestion/SKILL.md). Backs the lab-ingestion skill
-- (decision 2026-08-25): the athlete drops a lab-report PDF into
-- `lab-reports/`, a Claude Code skill reads it directly (native PDF reading,
-- no OCR library) and extracts every marker into a CSV with a self-assessed
-- per-row confidence (0-1), then `pnpm import:labs` upserts it. Rows below
-- the confidence threshold are flagged `needs_review` so a doubtful figure
-- never silently passes as trusted.
--
-- Deliberately NOT mirrored from sihha: `lab_documents` (a Storage-bucket-
-- backed upload-tracking table with RLS) and its admin review e-mail. Agon
-- has no Supabase Storage usage (CLAUDE.md already decided against
-- @supabase/supabase-js) and is single-user with no alerting-ledger layer, so
-- there's no upload API, no signed URLs, and no separate person to e-mail —
-- the raw PDF lives on the local filesystem (`lab-reports/`, gitignored,
-- moved to `lab-reports/processed/` once imported) and the skill reports
-- low-confidence rows straight to the athlete's own session instead of
-- sending mail.

ALTER TABLE public.lab_panel_results
  ADD COLUMN confidence NUMERIC CHECK (confidence BETWEEN 0 AND 1),
  ADD COLUMN needs_review BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN model TEXT;

COMMENT ON COLUMN public.lab_panel_results.confidence IS
  'Extractor self-assessed confidence (0-1) when imported via the lab-ingestion skill; null for manually-entered/API-logged results.';
COMMENT ON COLUMN public.lab_panel_results.needs_review IS
  'True when confidence fell below the import threshold (AGON_LAB_OCR_CONFIDENCE_MIN, default 0.85) — a doubtful figure to double-check, not yet a trusted value.';
COMMENT ON COLUMN public.lab_panel_results.model IS
  'The extractor model id that produced this row, if imported (e.g. claude-sonnet-5); null otherwise.';
