-- Start coordinates of a run, from Strava's start_latlng (previously dropped).
-- Needed to join weather on start time + GPS (the Open-Meteo enrichment) and,
-- later, for map/segment features. Nullable: treadmill/manual runs have none.
-- The weather columns themselves (temp_c, humidity_pct, wind_kph,
-- weather_conditions) already exist on runs from the core schema.
ALTER TABLE public.runs
  ADD COLUMN start_lat DOUBLE PRECISION CHECK (start_lat BETWEEN -90 AND 90),
  ADD COLUMN start_lng DOUBLE PRECISION CHECK (start_lng BETWEEN -180 AND 180);
