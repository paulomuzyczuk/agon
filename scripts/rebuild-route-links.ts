import { loadEnv } from './loadEnv';
import { query, closeDbPool } from '../services/db';
import { candidateToMapsUrl } from '../services/routing/mapsLink';
import type { RouteProfile } from '../services/routing/types';
import { logger } from '../services/logger';

// Re-derive the Google Maps deep-link of already-saved routes from their stored
// geometry, so a change to the via-point selection in services/routing/mapsLink.ts
// (e.g. MZY-31's shape-based vias) reaches routes generated before it. Only the
// link changes — geometry, GPX, distance and labels are untouched, so no routing
// API calls. Follow with `pnpm gcal:sync --from=<date> --reconcile` to push the
// new links into the calendar events (the sync reuses stored links).
//
// Scope: AUTO routes attached to planned sessions on/after --from (default:
// tomorrow). Ad-hoc routes are skipped — their through/finish points aren't
// persisted, and rebuilding without them could drop a pinned waypoint.
//
//   pnpm tsx scripts/rebuild-route-links.ts [--from=YYYY-MM-DD]           DRY RUN
//   pnpm tsx scripts/rebuild-route-links.ts [--from=YYYY-MM-DD] --write

function tomorrowISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
}

/** The profile a stored link was built for, read back from its travelmode. */
function profileOf(mapsUrl: string | null): RouteProfile {
  return mapsUrl?.includes('travelmode=bicycling')
    ? 'cycling-regular'
    : 'foot-walking';
}

async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const from =
    args.find((a) => a.startsWith('--from='))?.slice('--from='.length) ??
    tomorrowISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    throw new Error(`rebuild-route-links: invalid --from '${from}'`);
  }
  logger.info('starting route-link rebuild', {
    job: 'rebuild-route-links',
    from,
    write,
  });

  const { rows } = await query<{
    id: string;
    date: string;
    rank: number;
    distance_m: number;
    geometry: number[][];
    maps_url: string | null;
  }>(
    `SELECT rs.id, ps.date::text AS date, rs.rank, rs.distance_m, rs.geometry,
            rs.maps_url
       FROM public.route_suggestions rs
       JOIN public.planned_sessions ps ON ps.id = rs.planned_session_id
      WHERE ps.date >= $1 AND rs.kind = 'auto'
      ORDER BY ps.date, rs.rank`,
    [from],
  );

  let changed = 0;
  for (const r of rows) {
    const next = candidateToMapsUrl(
      {
        seed: 0,
        distanceM: r.distance_m,
        elevationGainM: null,
        coordinates: r.geometry,
        provider: 'stored',
      },
      [],
      profileOf(r.maps_url),
    );
    if (next === r.maps_url) continue;
    changed++;
    if (write) {
      await query(
        `UPDATE public.route_suggestions
            SET maps_url = $2, updated_at = now()
          WHERE id = $1`,
        [r.id, next],
      );
    }
  }

  console.log(
    `\nRoutes on/after ${from}: ${rows.length} · link changed: ${changed}\n` +
      (write
        ? `WROTE ${changed} maps_url update(s). Next: pnpm gcal:sync --from=${from} --reconcile\n`
        : 'DRY RUN — no changes written. Re-run with --write to apply.\n'),
  );
}

main()
  .catch((err) => {
    logger.error('rebuild-route-links failed', {
      job: 'rebuild-route-links',
      err,
    });
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
