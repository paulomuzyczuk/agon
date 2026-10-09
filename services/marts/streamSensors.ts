import { query } from '@/services/db';
import { formatSourceDevices, type SourceDevice } from '@/lib/sourceDevices';

/**
 * "Garmin HRM 200 (HR) · Assioma Duo (power)" for a run/ride, from the
 * stream row that recorded its devices (MZY-271 — live recordings only), or
 * null when no stream knows its devices (every import).
 */
export async function streamSensors(
  kind: 'run' | 'ride',
  id: string,
): Promise<string | null> {
  const sql =
    kind === 'run'
      ? `select source_devices from run_streams
          where run_id = $1::uuid and source_devices is not null
          order by source limit 1`
      : `select source_devices from ride_streams
          where ride_id = $1::uuid and source_devices is not null
          order by source limit 1`;
  const { rows } = await query<{ source_devices: SourceDevice[] }>(sql, [id]);
  return formatSourceDevices(rows[0]?.source_devices);
}
