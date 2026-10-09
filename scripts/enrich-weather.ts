import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import {
  backfillWeather,
  backfillRideWeather,
} from '../services/weather/enrich';
import { logger } from '../services/logger';

// Weather enrichment of runs AND rides from Open-Meteo (free, keyless).
// Idempotent + resumable: only activities with a start time, a location (GPS
// start, else AGON_HOME_LAT/LNG — MZY-226) and no weather yet are
// fetched. Every sync now runs this automatically; this script is for manual
// catch-up and --force re-fetches.
//
//   pnpm weather:backfill            fill missing weather (runs + rides)
//   pnpm weather:backfill --force    re-fetch all GPS activities
//
// A REAL ingestion job — no seed guard. No API key needed.

async function main(): Promise<void> {
  loadEnv();
  const force = process.argv.includes('--force');

  const summary = await backfillWeather({ force });

  // eslint-disable-next-line no-console
  console.log(
    `\nWeather (runs): ${summary.enriched} enriched, ${summary.noData} without data, ` +
      `of ${summary.candidates} candidates` +
      `${summary.estimated ? ` (${summary.estimated} at home location — no GPS)` : ''}` +
      `${summary.rateLimited ? ' (STOPPED on rate limit — re-run to resume)' : ''}.\n`,
  );

  const rideSummary = await backfillRideWeather({ force });

  // eslint-disable-next-line no-console
  console.log(
    `Weather (rides): ${rideSummary.enriched} enriched, ${rideSummary.noData} without data, ` +
      `of ${rideSummary.candidates} candidates` +
      `${rideSummary.estimated ? ` (${rideSummary.estimated} at home location — no GPS)` : ''}` +
      `${rideSummary.rateLimited ? ' (STOPPED on rate limit — re-run to resume)' : ''}.\n`,
  );
}

main()
  .catch((err) => {
    logger.error('weather backfill failed', { job: 'weather-backfill' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
