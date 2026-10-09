-- Per-data-point device provenance for live recordings (MZY-271). The live
-- recorder (app/record) can pair several BLE devices at once — HR strap, CSC
-- speed sensor, CSC cadence sensor, power meter — and merges their samples
-- into one stream row. Until now, WHICH physical device produced a value was
-- lost. Now:
--
--   source_devices            JSONB array, one entry per device that supplied
--                             any value in this row, in order of first use:
--                             {"name": "...", "kind": "heart_rate"|"csc"|"power",
--                              "ble_id": "<Web Bluetooth BluetoothDevice.id>"}.
--                             ble_id is opaque and only stable per site.
--   <metric>_source_device    SMALLINT[] index-aligned with time_s like every
--                             other series: element i is the 0-based index into
--                             source_devices of the device that produced
--                             <metric>[i], NULL where <metric>[i] is NULL.
--
-- Only ONE device per metric is ever recorded at a time: the recorder writes
-- only the primary's samples (earliest-paired device still connected; a CSC
-- cadence sensor outranks a power meter's crank cadence). A change of index
-- along an array is a switchover (the primary disconnected).
--
-- Live recordings only. Every import path (Strava, Google Health, file
-- exports) leaves all of these NULL = unknown: those sources name at most the
-- activity's recording device, not which sensor produced each point.
--
-- Grants: none needed — dbt_writer's SELECT on run_streams/ride_streams and
-- mcp_reader's SELECT ON ALL TABLES are table-level and cover new columns.
--
-- EXPAND phase only: nullable columns, nothing destroyed; every existing row
-- satisfies the CHECKs (all NULL).

ALTER TABLE public.run_streams
  ADD COLUMN source_devices          JSONB
    CHECK (source_devices IS NULL OR jsonb_typeof(source_devices) = 'array'),
  ADD COLUMN heartrate_source_device SMALLINT[],
  ADD CONSTRAINT run_streams_source_device_aligned CHECK (
    heartrate_source_device IS NULL
    OR (source_devices IS NOT NULL
        AND cardinality(heartrate_source_device) = cardinality(time_s))
  );

ALTER TABLE public.ride_streams
  ADD COLUMN source_devices          JSONB
    CHECK (source_devices IS NULL OR jsonb_typeof(source_devices) = 'array'),
  ADD COLUMN heartrate_source_device SMALLINT[],
  ADD COLUMN cadence_source_device   SMALLINT[],
  ADD COLUMN velocity_source_device  SMALLINT[],
  ADD COLUMN watts_source_device     SMALLINT[],
  ADD CONSTRAINT ride_streams_source_device_aligned CHECK (
    (heartrate_source_device IS NULL
      OR cardinality(heartrate_source_device) = cardinality(time_s))
    AND (cadence_source_device IS NULL
      OR cardinality(cadence_source_device) = cardinality(time_s))
    AND (velocity_source_device IS NULL
      OR cardinality(velocity_source_device) = cardinality(time_s))
    AND (watts_source_device IS NULL
      OR cardinality(watts_source_device) = cardinality(time_s))
  ),
  ADD CONSTRAINT ride_streams_source_device_listed CHECK (
    source_devices IS NOT NULL
    OR (heartrate_source_device IS NULL AND cadence_source_device IS NULL
        AND velocity_source_device IS NULL AND watts_source_device IS NULL)
  );

COMMENT ON COLUMN public.run_streams.source_devices IS
  'Live recordings only (MZY-271): devices that supplied this row, [{name, kind, ble_id}]. NULL = unknown (imports).';
COMMENT ON COLUMN public.ride_streams.source_devices IS
  'Live recordings only (MZY-271): devices that supplied this row, [{name, kind, ble_id}]. NULL = unknown (imports).';
COMMENT ON COLUMN public.ride_streams.watts_source_device IS
  'Per point: index into source_devices of the device that produced watts[i] (MZY-271).';
