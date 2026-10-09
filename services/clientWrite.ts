import { createHash } from 'crypto';
import { z } from 'zod';

// Idempotent client writes (MZY-205, local-first phase 1). Every PWA write is
// queued in the device outbox (lib/outbox.ts) and may be delivered more than
// once — a flush that dropped after the server committed but before the
// response arrived is retried. Two fields travel with every such write:
//
//   clientId    the mutation's UUID, generated on the device. It becomes the
//               row's primary key, and the insert is ON CONFLICT (id) DO
//               NOTHING — so a replay is a no-op, like `(source, external_id)`
//               for ingested runs.
//   capturedAt  when the athlete acted, on the device clock. The server uses
//               it for the row's date and created_at and never substitutes
//               its own "now" — a write delivered hours later still lands on
//               the day it happened (the resolveDate lesson, e4b7076).
//
// Both are optional so the Telegram bot and scripts, which call the same
// services directly, keep working unchanged.

export const ClientWriteMetaSchema = z.object({
  clientId: z.string().uuid().optional(),
  capturedAt: z.string().datetime({ offset: true }).optional(),
});

export type ClientWriteMeta = z.infer<typeof ClientWriteMetaSchema>;

/**
 * A stable UUID for the Nth row a single client mutation creates (e.g. one
 * meal_logs row per slot when a whole template is logged). RFC 4122 v5 —
 * SHA-1 of the base UUID's bytes + `name` — so a replay derives exactly the
 * same ids and every row's insert conflicts, instead of creating new ones.
 */
export function deriveUuid(base: string, name: string): string {
  const hash = createHash('sha1')
    .update(Buffer.from(base.replace(/-/g, ''), 'hex'))
    .update(name)
    .digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The per-row half of a client write, accepted by every athlete-authored
 * insert in services/: `id` = the mutation's clientId (or a deriveUuid of it),
 * `capturedAt` = device time → created_at. Both absent for bot/script callers.
 */
export interface ClientRowKeys {
  id?: string;
  capturedAt?: string;
}
