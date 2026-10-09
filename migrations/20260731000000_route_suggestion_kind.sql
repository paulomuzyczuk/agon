-- Route builder — ad-hoc routes (CLAUDE.md #6). Distinguish the auto-generated
-- loops attached to a run event ("🗺️ Suggested routes from home") from ad-hoc
-- routes the athlete requests via Telegram /route ("🧭 Ad hoc routes"), so the
-- calendar description can render them in separate sections and the auto-route
-- regeneration never touches ad-hoc ones.
--
-- EXPAND only: one nullable-defaulted column; existing rows are all 'auto'.
ALTER TABLE public.route_suggestions
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'auto'
    CHECK (kind IN ('auto', 'adhoc'));
