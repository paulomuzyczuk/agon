import { loadEnv } from './loadEnv';
import { query, closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import { getAthleteProfile } from '../lib/athleteProfile';
import { hrmForDate } from '../lib/gear';
import {
  parseManualRideArgs,
  buildManualRideRecord,
  type ManualRideInput,
} from '../lib/manualRide';
import { upsertRide } from '../services/strava/rideIngest';
import { upsertGear, linkRideGear } from '../services/gear';
import { findOverlappingActivities } from '../services/activitySources';
import { recomputeDerivedForActivity } from '../services/activityDerived';

// Log a bike ride by hand — the standard path for a ride no source captured
// (forgot to start Strava, a Garmin Speed Sensor upload that Strava sync
// ignores on purpose, …). Documented in .claude/rules/run-ingestion.md
// ("Logging a ride by hand").
//
//   pnpm ride:add --date=2026-10-03 --start=21:09 --km=6.97 --duration=24:00 \
//     --avg-hr=127 --hr-estimated --strap \
//     --notes="Forgot to record on Strava." [--write]
//
// Required: --date (YYYY-MM-DD, local), --start (HH:MM, athlete-local time
// zone), --km, --duration (mm:ss | h:mm:ss | seconds).
// Optional: --avg-hr, --max-hr, --hr-estimated (avg HR is a guess, noted in
// general_notes), --strap (link the chest strap worn on that date),
// --elevation (m), --rpe (1-10), --avg-power / --max-power (W) and --kj
// (read off a head unit by hand — stored with power_source 'manual', never
// fed into NP/TSS), --bike (gear name or id; default = the
// bike on the most recent ride), --notes (free text, appended to the
// provenance line).
//
// DRY RUN by default — prints the row; --write persists it. Idempotent:
// source 'manual' + external_id `manual-<date>-<HHMM>`, so re-running with
// corrected numbers updates the same ride. Refuses when another ride already
// overlaps the interval (it was synced after all) unless --force.
// After writing: links gear, then re-derives weather (home-location estimate —
// no GPS), Relative Effort, fueling balance and training load for the ride.

async function resolveBike(
  bike: string | undefined,
): Promise<{ gearId: string; name: string } | null> {
  if (bike !== undefined) {
    const { rows } = await query<{ gear_id: string; name: string }>(
      `SELECT gear_id, name FROM public.gear
        WHERE category = 'bike' AND (gear_id = $1 OR lower(name) = lower($1))
        ORDER BY (gear_id = $1) DESC LIMIT 1`,
      [bike],
    );
    if (!rows[0]) throw new Error(`no bike gear matches '${bike}'`);
    return { gearId: rows[0].gear_id, name: rows[0].name };
  }
  const { rows } = await query<{ gear_id: string; name: string }>(
    `SELECT g.gear_id, g.name
       FROM public.rides r
       JOIN public.ride_gear rg ON rg.ride_id = r.id
       JOIN public.gear g ON g.gear_id = rg.gear_id AND g.category = 'bike'
      ORDER BY r.started_at DESC NULLS LAST LIMIT 1`,
  );
  return rows[0] ? { gearId: rows[0].gear_id, name: rows[0].name } : null;
}

async function run(input: ManualRideInput): Promise<void> {
  const profile = getAthleteProfile();
  const bike = await resolveBike(input.bike);
  const ride = buildManualRideRecord(
    input,
    profile.timeZone,
    bike?.name ?? null,
  );
  const hrm = input.strap ? hrmForDate(input.date) : null;

  const startMs = Date.parse(ride.started_at!);
  const overlaps = await findOverlappingActivities(
    'ride',
    startMs,
    startMs + ride.duration_s * 1000,
    { source: ride.source, externalId: ride.external_id },
  );

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      `Ride ${ride.external_id}`,
      `  ${ride.date} start ${input.start} local (${ride.started_at})  Block ${ride.block} · Week ${ride.week}`,
      `  ${ride.distance_km} km in ${Math.floor(ride.duration_s / 60)}:${String(ride.duration_s % 60).padStart(2, '0')}  → ${ride.avg_speed_kmh} km/h`,
      `  avg HR ${ride.avg_hr ?? '-'}${input.hrEstimated ? ' (estimate)' : ''}  max HR ${ride.max_hr ?? '-'}  RPE ${ride.perceived_effort ?? '-'}`,
      `  bike ${bike?.name ?? '(none)'}  HRM ${hrm?.name ?? '(none)'}`,
      `  notes: ${ride.general_notes}`,
      overlaps.length > 0
        ? `  OVERLAPS ${overlaps.map((o) => `${o.source}:${o.id}`).join(', ')}`
        : '  no overlapping ride',
      '',
    ].join('\n'),
  );

  if (overlaps.length > 0 && !input.force) {
    throw new Error(
      'another ride already covers this time — it was probably synced. ' +
        'Correct that one instead (PATCH /api/rides/:id), or pass --force.',
    );
  }
  if (!input.write) {
    // eslint-disable-next-line no-console
    console.log('DRY RUN — nothing written. Re-run with --write to persist.');
    return;
  }

  const result = await upsertRide(ride);
  // upsertRide leaves the qualitative fields alone (sources never own them);
  // for a manual ride they're ours, so set them — a re-run overwrites.
  await query(
    `UPDATE public.rides SET general_notes = $2, perceived_effort = $3 WHERE id = $1`,
    [result.id, ride.general_notes, ride.perceived_effort],
  );
  if (bike) await linkRideGear(result.id, bike.gearId);
  if (hrm) {
    await upsertGear({
      gear_id: hrm.gear_id,
      name: hrm.name,
      brand: hrm.brand,
      source: 'local',
      category: 'hrm',
    });
    await linkRideGear(result.id, hrm.gear_id);
  }

  const derived = await recomputeDerivedForActivity('ride', result.id, {
    startMoved: true,
    fromDate: ride.date,
  });
  // eslint-disable-next-line no-console
  console.log(
    `${result.status === 'inserted' ? 'Inserted' : 'Updated'} ride ${result.id}. ` +
      `Derived: ${derived.ok.join(', ') || 'none'}` +
      (derived.failed.length ? ` — FAILED: ${derived.failed.join(', ')}` : ''),
  );
}

async function main(): Promise<void> {
  loadEnv();
  const input = parseManualRideArgs(process.argv.slice(2));
  logger.info('manual ride entry', { job: 'manual-ride', write: input.write });
  await run(input);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
