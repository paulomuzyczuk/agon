// Hybrid logical clock (MZY-206) — the ordering behind field-level
// last-writer-wins (lib/sync/mergeField.ts). Pure; the device keeps its last
// value in IndexedDB (lib/sync/deviceClock.ts), the server builds its own.
//
// An HLC is (wall ms, counter, node). It follows physical time when clocks
// are sane, but never goes backwards and always orders an event after any
// event it has seen, even when two clocks disagree. `node` (the device id)
// is the final, deterministic tiebreak, so two different writers never
// produce equal stamps.
//
// Serialised as `<wall:15 digits>:<counter:6 digits>:<node>` so plain string
// comparison of two stamps orders them — handy in SQL (`field_hlc` JSONB) and
// in the pull cursor's consumers — but compareHlc() is the one to use in code.
//
// Timestamps are taken when the athlete acts (tickHlc at the edit), never
// when the server processes it (the resolveDate lesson, e4b7076).

export interface Hlc {
  wall: number; // epoch ms
  counter: number;
  node: string;
}

const NODE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_COUNTER = 999_999;

export class HlcError extends Error {}

export function formatHlc(h: Hlc): string {
  if (!NODE.test(h.node)) throw new HlcError(`invalid HLC node "${h.node}"`);
  if (h.counter > MAX_COUNTER) throw new HlcError('HLC counter overflow');
  return `${String(h.wall).padStart(15, '0')}:${String(h.counter).padStart(6, '0')}:${h.node}`;
}

const HLC_RE = /^(\d{15}):(\d{6}):([A-Za-z0-9_-]{1,64})$/;

export function parseHlc(s: string): Hlc {
  const m = HLC_RE.exec(s);
  if (!m) throw new HlcError(`invalid HLC "${s}"`);
  return { wall: Number(m[1]), counter: Number(m[2]), node: m[3]! };
}

export function isHlc(s: unknown): s is string {
  return typeof s === 'string' && HLC_RE.test(s);
}

export function compareHlc(a: string, b: string): number {
  const x = parseHlc(a);
  const y = parseHlc(b);
  if (x.wall !== y.wall) return x.wall < y.wall ? -1 : 1;
  if (x.counter !== y.counter) return x.counter < y.counter ? -1 : 1;
  if (x.node === y.node) return 0;
  return x.node < y.node ? -1 : 1;
}

/** A local event (the athlete edits something): strictly after `last`. */
export function tickHlc(last: Hlc | null, nowMs: number, node: string): Hlc {
  const lastWall = last?.wall ?? 0;
  const wall = Math.max(lastWall, nowMs);
  const counter = last && wall === lastWall ? last.counter + 1 : 0;
  return { wall, counter, node };
}

/** Merge a stamp seen from elsewhere, so the next local tick orders after it. */
export function receiveHlc(last: Hlc | null, remote: Hlc, nowMs: number, node: string): Hlc {
  const lastWall = last?.wall ?? 0;
  const wall = Math.max(lastWall, remote.wall, nowMs);
  let counter: number;
  if (wall === lastWall && wall === remote.wall) {
    counter = Math.max(last!.counter, remote.counter) + 1;
  } else if (wall === lastWall) {
    counter = last!.counter + 1;
  } else if (wall === remote.wall) {
    counter = remote.counter + 1;
  } else {
    counter = 0;
  }
  return { wall, counter, node };
}

/**
 * Server-side guard against a device clock set far in the future: its edits
 * would otherwise win every conflict until real time catches up. A stamp
 * more than `maxDriftMs` ahead of the server is pulled back to server time
 * (keeping counter + node), so the edit still lands but can't pre-empt edits
 * made after it. Returns the stamp unchanged when within bounds.
 *
 * Trade-off: a clamped stamp depends on when it arrived, so a REPLAY of a
 * far-future write re-applies (same value, newer stamp) instead of being a
 * no-op. Chosen over rejecting it: the athlete's edit is kept, and the only
 * cost is that a skewed device's replay can win against an edit made between
 * its two deliveries.
 */
export function clampHlc(stamp: string, serverNowMs: number, maxDriftMs: number): string {
  const h = parseHlc(stamp);
  if (h.wall <= serverNowMs + maxDriftMs) return stamp;
  return formatHlc({ ...h, wall: serverNowMs });
}
