-- Local-first sync bookkeeping (MZY-206, phase 2 of MZY-28).
--
-- Adds to every replicated (athlete-authored) table:
--   sync_seq     BIGINT       monotonic pull cursor, set by trigger from one
--                             global sequence (updated_at is unsafe as a
--                             cursor across concurrent transactions)
--   field_hlc    JSONB        {field: {"hlc": "<hlc>", "origin": "human"|"machine"}}
--                             — the per-field stamps mergeField() compares.
--                             (Origin is kept per field, not only per row, so a
--                             machine write can still update fields no human
--                             has touched.)
--   edit_origin  TEXT         origin of the row's latest write
--   deleted_at   TIMESTAMPTZ  tombstone: deletes become soft, so a delete can
--                             replicate. Every reader must filter
--                             deleted_at IS NULL (services, MCP, dbt staging).
-- plus sync_id_aliases (a second device's id for a natural-key row that
-- already exists → the canonical row; see services/sync/apply.ts).
--
-- Ordering: the trigger takes one transaction-scoped advisory lock before
-- nextval(), so writers to replicated tables serialise and sync_seq order is
-- commit order — a pull can never skip a row that commits late with a lower
-- seq. Single-athlete write volume makes the serialisation free in practice.
--
-- Writers that don't go through the sync push path (the phase-1 routes,
-- scripts, Calendar reconcile until phase 4) are stamped by the trigger with a
-- server HLC and origin = current_setting('agon.edit_origin') (default
-- 'human'). The push path sets `agon.sync_apply = on` and writes field_hlc
-- itself. Existing rows are backfilled with a stamp at their created_at;
-- machine-extracted lab results (source_file/model set) as origin 'machine'.
--
-- EXPAND only: new nullable/defaulted columns, a new table, a trigger.
-- Nothing dropped or tightened.

CREATE SEQUENCE public.sync_seq_global;

CREATE TABLE public.sync_id_aliases (
  alias_id      UUID PRIMARY KEY,
  table_name    TEXT NOT NULL,
  canonical_id  UUID NOT NULL,
  sync_seq      BIGINT NOT NULL DEFAULT nextval('public.sync_seq_global'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sync_id_aliases_seq ON public.sync_id_aliases (sync_seq);

CREATE FUNCTION public.sync_stamp() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_row  jsonb;
  old_row  jsonb;
  k        text;
  stamp    jsonb;
  changed  jsonb := '{}'::jsonb;
  origin   text;
BEGIN
  -- Serialise writers so sync_seq order = commit order (see header).
  PERFORM pg_advisory_xact_lock(hashtext('agon.sync_seq'));
  NEW.sync_seq := nextval('public.sync_seq_global');

  IF current_setting('agon.sync_apply', true) = 'on' THEN
    RETURN NEW; -- services/sync/apply.ts stamped field_hlc/edit_origin itself
  END IF;

  origin := coalesce(nullif(current_setting('agon.edit_origin', true), ''), 'human');
  IF origin NOT IN ('human', 'machine') THEN
    RAISE EXCEPTION 'agon.edit_origin must be human or machine, got %', origin;
  END IF;
  stamp := jsonb_build_object(
    'hlc', lpad(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text, 15, '0')
           || ':000000:server',
    'origin', origin);

  new_row := to_jsonb(NEW);
  old_row := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  FOR k IN SELECT jsonb_object_keys(new_row) LOOP
    CONTINUE WHEN k IN ('id', 'created_at', 'updated_at', 'sync_seq', 'field_hlc', 'edit_origin');
    IF TG_OP = 'INSERT' OR (new_row -> k) IS DISTINCT FROM (old_row -> k) THEN
      changed := changed || jsonb_build_object(k, stamp);
    END IF;
  END LOOP;

  NEW.field_hlc := coalesce(NEW.field_hlc, '{}'::jsonb) || changed;
  NEW.edit_origin := origin;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'meal_logs', 'meal_log_items',
    'health_conditions', 'injuries', 'injury_updates', 'medications', 'medication_logs',
    'medical_visits', 'vaccinations', 'routines', 'routine_steps', 'routine_logs',
    'lab_panels', 'lab_panel_results',
    'session_adjustments'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE public.%I
         ADD COLUMN sync_seq BIGINT,
         ADD COLUMN field_hlc JSONB NOT NULL DEFAULT ''{}''::jsonb,
         ADD COLUMN edit_origin TEXT NOT NULL DEFAULT ''human''
           CHECK (edit_origin IN (''human'', ''machine'')),
         ADD COLUMN deleted_at TIMESTAMPTZ', t);

    -- Backfill: every existing field stamped at the row's created_at, node
    -- 'backfill' (older than any real edit, so the first sync edit wins).
    -- Runs before the trigger exists; sync_seq assigned here in id order.
    EXECUTE format(
      'UPDATE public.%I r SET
         sync_seq = nextval(''public.sync_seq_global''),
         edit_origin = o.origin,
         field_hlc = (
           SELECT coalesce(jsonb_object_agg(key, jsonb_build_object(
             ''hlc'', lpad(floor(extract(epoch FROM r.created_at) * 1000)::bigint::text, 15, ''0'')
                     || '':000000:backfill'',
             ''origin'', o.origin)), ''{}''::jsonb)
           FROM jsonb_object_keys(to_jsonb(r)) AS key
           WHERE key NOT IN (''id'', ''created_at'', ''updated_at'', ''sync_seq'',
                             ''field_hlc'', ''edit_origin''))
       FROM (SELECT id, %s AS origin FROM public.%I) o
       WHERE o.id = r.id',
      t,
      CASE WHEN t = 'lab_panel_results'
        THEN $o$CASE WHEN source_file IS NOT NULL OR model IS NOT NULL THEN 'machine' ELSE 'human' END$o$
        ELSE $o$'human'$o$ END,
      t);

    EXECUTE format('CREATE INDEX %I ON public.%I (sync_seq)', 'idx_' || t || '_sync_seq', t);
    EXECUTE format(
      'CREATE TRIGGER sync_stamp BEFORE INSERT OR UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.sync_stamp()', t);
  END LOOP;
END;
$$;

-- The consulting layer can see aliases like every other public table
-- (mcp_reader's SELECT ON ALL TABLES predates this table).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_reader') THEN
    GRANT SELECT ON public.sync_id_aliases TO mcp_reader;
  END IF;
END;
$$;
