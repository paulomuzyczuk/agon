-- CONTRACT half of the expand/contract pair begun in the previous migration.
-- run_gear now holds every run<->gear link (see _004000), and the ingestion code
-- writes there, so the legacy single-shoe runs.gear_id column is retired.
-- runs.shoe_used stays as the denormalized shoe name.
ALTER TABLE public.runs DROP COLUMN gear_id;
