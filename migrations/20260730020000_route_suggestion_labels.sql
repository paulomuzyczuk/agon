-- Route builder v2 (CLAUDE.md #6): directional diversity + place-based labels.
-- Each run event now carries 3 significantly different loops (spread across the
-- compass), and each link's text describes where it goes (neighbourhoods it
-- passes through, e.g. "Tempelhof, Schöneberg and Wilmersdorf"). Cache the
-- computed direction + label so re-syncs don't re-hit the geocoder.
--
-- EXPAND only: two nullable columns; existing rows keep NULL (older single-route
-- suggestions predate diversity/labels).
ALTER TABLE public.route_suggestions
  ADD COLUMN direction TEXT,   -- compass heading of the loop's apex (N/NE/…)
  ADD COLUMN via_label TEXT;   -- "Route 1 · 8.3 km — Tempelhof, Schöneberg …"
