-- Route builder (CLAUDE.md Premium-Parity #6): persisted target-distance route
-- suggestions. Each `suggestRoutes` run generates a few candidate loops from a
-- start point via an OSM routing engine (OpenRouteService round_trip); the CLI
-- saves them here, and one may later be attached to a planned_sessions row for
-- planned-vs-actual GPS comparison against run_streams.
--
-- The MCP `suggest_routes` tool stays READ-ONLY and does NOT write this table —
-- generation is an outbound API call it can return directly. Saving + attaching
-- are deliberate writes done via `pnpm route:suggest --save` / `pnpm route:attach`
-- with the normal writer role (mirrors gcal sync being CLI-only). mcp_reader's
-- blanket future-table SELECT grant covers this table; it holds no secrets.

CREATE TABLE public.route_suggestions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Candidates generated together in one request share a batch_id, so a saved
  -- suggestion set can be listed/attached as a group.
  batch_id           UUID NOT NULL,
  -- The request that produced this candidate.
  requested_km       NUMERIC(6,2) NOT NULL CHECK (requested_km > 0),
  start_lat          DOUBLE PRECISION NOT NULL,
  start_lng          DOUBLE PRECISION NOT NULL,
  start_label        TEXT,                      -- resolved place label / "home"
  waypoints          JSONB,                     -- reserved for through/finish (v1.1)
  -- The generated loop.
  provider           TEXT NOT NULL,             -- e.g. "openrouteservice" (no CHECK: provider-neutral)
  seed               INT NOT NULL,              -- the shape seed (reproducible)
  rank               INT NOT NULL,              -- 1-based position within the batch
  distance_m         DOUBLE PRECISION NOT NULL, -- actual loop length
  elevation_gain_m   INT,                       -- total ascent, null if unknown
  geometry           JSONB NOT NULL,            -- [[lng,lat,ele?], ...] route coordinates
  gpx                TEXT NOT NULL,             -- the watch-ready GPX document
  maps_url           TEXT,                      -- Google Maps walking deep-link
  -- Composition: a chosen suggestion attaches to a planned session. ON DELETE
  -- SET NULL so removing a plan row doesn't delete route history.
  planned_session_id UUID REFERENCES public.planned_sessions(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_route_suggestions_batch ON public.route_suggestions (batch_id);
CREATE INDEX idx_route_suggestions_planned_session
  ON public.route_suggestions (planned_session_id)
  WHERE planned_session_id IS NOT NULL;

CREATE TRIGGER trg_route_suggestions_touch BEFORE UPDATE ON public.route_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
