import { loadEnv } from './loadEnv';
import { closeDbPool, query } from '../services/db';
import { logger } from '../services/logger';
import { getValidAccessToken } from '../services/googleHealth/oauth';
import { fetchGoogleHealthHeartRateStream } from '../services/googleHealth/heartRate';
import { hasRideStreams, upsertRideStreams } from '../services/runStreams';
import { updateRideHr } from '../services/rides';
import { recomputeDerivedForActivity } from '../services/activityDerived';

// Fill the heart rate of rides a higher-priority source (Strava) stored without
// any, from Google Health's wrist HR over the ride's window. A Google Health
// twin of such a ride is skipped at ingest (lib/activitySourcePriority.ts), so
// its HR never arrives on its own. The series lands in ride_streams under
// 'fitbit' (as in services/googleHealth/rideIngest.ts) and avg/max only FILL
// null columns.
//
//   pnpm ride:fill-hr --from=2026-10-19            dry run: print what it would do
//   pnpm ride:fill-hr --from=2026-10-19 --write    persist + re-derive effort/load

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface RideRow {
  id: string;
  started_at: Date;
  duration_s: number;
  date: Date;
}

async function main(): Promise<void> {
  loadEnv();
  const from = process.argv
    .find((a) => a.startsWith('--from='))
    ?.slice('--from='.length);
  if (!from || !DATE_RE.test(from)) {
    throw new Error(
      `ride:fill-hr: --from=YYYY-MM-DD is required (got '${from ?? ''}')`,
    );
  }
  const write = process.argv.includes('--write');

  // The stream time origin is the source's own start (source_started_at when a
  // missed-start correction moved started_at).
  const { rows } = await query<RideRow>(
    `SELECT id, COALESCE(source_started_at, started_at) AS started_at,
            duration_s, date
       FROM public.rides
      WHERE avg_hr IS NULL AND date >= $1
        AND NOT EXISTS (SELECT 1 FROM public.ride_streams s
                         WHERE s.ride_id = rides.id AND s.source = 'fitbit')
      ORDER BY started_at`,
    [from],
  );
  const accessToken = await getValidAccessToken();
  for (const ride of rows) {
    const startMs = ride.started_at.getTime();
    const endMs = startMs + ride.duration_s * 1000;
    const hr = await fetchGoogleHealthHeartRateStream(
      accessToken,
      startMs,
      endMs,
    );
    const when = ride.started_at.toISOString();
    if (!hr) {
      logger.info('ride:fill-hr no Google Health HR in window', {
        rideId: ride.id,
        when,
      });
      continue;
    }
    logger.info(write ? 'ride:fill-hr filling' : 'ride:fill-hr would fill', {
      rideId: ride.id,
      when,
      samples: hr.stream.timeS.length,
      avgHr: hr.avgHr,
      maxHr: hr.maxHr,
    });
    if (!write) continue;
    if (!(await hasRideStreams(ride.id, 'fitbit'))) {
      await upsertRideStreams(ride.id, 'fitbit', hr.stream);
    }
    await updateRideHr(ride.id, hr.avgHr, hr.maxHr);
    await recomputeDerivedForActivity('ride', ride.id, {
      startMoved: false,
      fromDate: ride.date.toISOString().slice(0, 10),
    });
  }
  // eslint-disable-next-line no-console
  console.log(
    `${rows.length} ride(s) without HR since ${from}${write ? '' : ' (dry run — pass --write to apply)'}`,
  );
}

main()
  .catch((err) => {
    logger.error('ride:fill-hr failed', { job: 'ride-fill-hr' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
