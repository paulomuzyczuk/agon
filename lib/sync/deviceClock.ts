import { formatHlc, parseHlc, receiveHlc, tickHlc, type Hlc } from './hlc';

// This device's identity and hybrid logical clock (MZY-206). The node id is
// the deterministic tiebreak in mergeField; the last HLC is persisted so the
// clock never runs backwards across reloads, even if the phone's wall clock
// is corrected backwards in between.
//
// localStorage, not IndexedDB: both reads are synchronous at the moment the
// athlete acts, and the values are tiny. Falls back to memory when storage is
// unavailable (private mode) — stamps are still valid, just not persistent.

const NODE_KEY = 'agon-device-id';
const LAST_KEY = 'agon-hlc-last';

const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    memory.set(key, value);
  }
}

export function deviceNodeId(): string {
  let id = read(NODE_KEY);
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    id = `d${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    write(NODE_KEY, id);
  }
  return id;
}

function last(): Hlc | null {
  const raw = read(LAST_KEY);
  try {
    return raw ? parseHlc(raw) : null;
  } catch {
    return null;
  }
}

/** Stamp an athlete action, now, on this device. */
export function nextHlc(nowMs: number = Date.now()): string {
  const next = tickHlc(last(), nowMs, deviceNodeId());
  const s = formatHlc(next);
  write(LAST_KEY, s);
  return s;
}

/** Fold in a stamp seen from another device (pulled), so later edits order after it. */
export function observeHlc(remote: string, nowMs: number = Date.now()): void {
  try {
    write(LAST_KEY, formatHlc(receiveHlc(last(), parseHlc(remote), nowMs, deviceNodeId())));
  } catch {
    // A malformed remote stamp is ignored; the local clock stays valid.
  }
}
