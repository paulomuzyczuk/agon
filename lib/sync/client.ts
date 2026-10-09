import {
  flushOutbox,
  listOutbox,
  onOutboxDelivered,
  startOutbox,
  submitRows as queueRows,
  type SubmitResult,
} from '../outbox';
import { pendingRows, type SyncRow } from '../outboxQueue';
import { applyLocalRows, pullReplica } from './replica';

// Sync orchestration for the PWA (MZY-207): the one entry point pages use to
// write, and the lifecycle that keeps the device replica current. Sits above
// lib/outbox.ts (push) and lib/sync/replica.ts (pull) so neither imports the
// other.

/** Write: shown locally at once, queued in the outbox, delivered when possible. */
export async function submitRows(input: {
  label: string;
  rows: SyncRow[];
}): Promise<SubmitResult> {
  await applyLocalRows(input.rows);
  const result = await queueRows(input);
  // A rejected write was removed from the outbox; re-pull so the replica drops it too.
  if (result.state === 'rejected') void syncNow();
  return result;
}

let syncing: Promise<boolean> | null = null;
let precacheRequested = false;

/** Once per page load, after a sync proves we're signed in: warm the offline shell. */
function requestPrecache(): void {
  if (
    precacheRequested ||
    typeof navigator === 'undefined' ||
    !navigator.serviceWorker
  )
    return;
  void navigator.serviceWorker.ready.then((reg) => {
    reg.active?.postMessage('precache');
    precacheRequested = true;
  });
}

/** Push whatever is queued, then pull everything new. Single-flight. */
export function syncNow(): Promise<boolean> {
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      await flushOutbox();
      const ok = await pullReplica(async () => pendingRows(await listOutbox()));
      if (ok) requestPrecache();
      return ok;
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

let started = false;

/** Idempotent; called once from the root layout on the client. */
export function startSync(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  startOutbox();

  if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }

  void syncNow();
  window.addEventListener('online', () => void syncNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow();
  });
  // After our own writes land, pull their merged server state (other
  // devices' edits to the same rows included).
  onOutboxDelivered(
    () => void pullReplica(async () => pendingRows(await listOutbox())),
  );
}
