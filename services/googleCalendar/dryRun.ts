import type { CalendarSyncDeps } from './sync';
import type { EventResource } from './types';

// `pnpm gcal:sync --dry-run` (MZY-406 / install audit F-29): run the whole sync
// against the real calendar state, but make every write a no-op. The loop then
// counts what it WOULD do — create (no linked event), update (linked), remove —
// without a single insert, patch or delete reaching Google, and without touching
// the link/snapshot columns. Reads (token, sessions, ad-hoc routes) stay real.
//
// Route generation is switched off: it calls the routing API and attaches routes
// in the DB, which is not a read. So a dry run reports the events, not their
// route links. A patch that would 404 (event deleted in Google) is counted as an
// update — only the real run finds that out.

const DRY_EVENT: EventResource = { id: 'dry-run' };

export function withDryRun(deps: CalendarSyncDeps): CalendarSyncDeps {
  return {
    ...deps,
    insert: async () => DRY_EVENT,
    patch: async () => DRY_EVENT,
    markSynced: async () => {},
    recordPushed: async () => {},
    markFuelingSynced: async () => {},
    unlinkFueling: async () => {},
    remove: async () => {},
    unlink: async () => {},
    resolveRoutes: async () => [],
    reconcile: (fromISO) => deps.reconcile(fromISO, true),
  };
}
