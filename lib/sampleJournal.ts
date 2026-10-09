// Durable native sample journal for app/record (MZY-294). About a minute
// after screen-off the Android WebView pauses the hidden page: IndexedDB
// writes queue in memory, and a process death loses every sample since
// (MZY-273 spike). A call INTO a native plugin made from a plugin callback
// still runs at once (MZY-294 spike: 2 calls/s held through 3 min of screen
// off), so lib/liveRecordingDb.ts also hands each sample to the in-repo
// AgonJournal plugin (android/.../SampleJournalPlugin.java), which appends
// it to an app-private file before returning. After a kill, the lines
// IndexedDB is missing are replayed into it (liveRecordingDb.replayJournals).
//
// Pattern: OpenTracks (Apache-2.0) and FitoTrack (GPL-3.0, idea only) persist
// each sample inside the app process as it arrives — reimplemented, no code
// copied (CREDITS.md).
//
// Event-driven only: the append is fired synchronously from the sample
// callback, never through a JS timer (they stall while the page is hidden).
// Outside the Android app every function is a no-op. The parsing/dedupe
// below is pure and unit-tested (__tests__/lib/sampleJournal.test.ts).

import { registerPlugin } from '@capacitor/core';
import { isNativeApp } from './platform';

/** The IndexedDB store a journal line belongs to (lib/liveRecordingDb.ts). */
export type JournalStore =
  | 'recordings'
  | 'hr_samples'
  | 'speed_samples'
  | 'cadence_samples'
  | 'power_samples'
  | 'gps_samples';

interface AgonJournalPlugin {
  append(o: {
    recordingId: string;
    store: JournalStore;
    sample: object;
  }): Promise<void>;
  read(o: {
    recordingId: string;
    offset: number;
  }): Promise<{ text: string; next: number }>;
  clear(o: { recordingId: string }): Promise<void>;
  list(): Promise<{ recordingIds: string[] }>;
}

const AgonJournal = registerPlugin<AgonJournalPlugin>('AgonJournal');

/**
 * Journals one record. Call it synchronously from the sample callback, before
 * any await — the bridge call must leave while the callback is running.
 */
export function journalAppend(
  recordingId: string,
  store: JournalStore,
  sample: object,
): void {
  if (!isNativeApp()) return;
  AgonJournal.append({ recordingId, store, sample }).catch(() => {});
}

export async function journalRead(recordingId: string): Promise<string> {
  if (!isNativeApp()) return '';
  let text = '';
  let offset = 0;
  while (offset >= 0) {
    const chunk = await AgonJournal.read({ recordingId, offset });
    text += chunk.text;
    offset = chunk.next;
  }
  return text;
}

export async function journalClear(recordingId: string): Promise<void> {
  if (!isNativeApp()) return;
  await AgonJournal.clear({ recordingId }).catch(() => {});
}

export async function journalRecordingIds(): Promise<string[]> {
  if (!isNativeApp()) return [];
  return (await AgonJournal.list()).recordingIds;
}

// ── Pure: parse + replay plan ───────────────────────────────────────────

export interface JournalEntry {
  store: JournalStore;
  record: Record<string, unknown>;
}

const STORES = new Set<string>([
  'recordings',
  'hr_samples',
  'speed_samples',
  'cadence_samples',
  'power_samples',
  'gps_samples',
]);

/** Journal text → entries; a torn last line (killed mid-write) is skipped. */
export function parseJournal(text: string): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const { s, d } = JSON.parse(line) as { s?: unknown; d?: unknown };
      if (
        typeof s === 'string' &&
        STORES.has(s) &&
        d &&
        typeof d === 'object'
      ) {
        out.push({
          store: s as JournalStore,
          record: d as Record<string, unknown>,
        });
      }
    } catch {
      // torn or garbled line — the rest of the journal still counts
    }
  }
  return out;
}

/** A sample's identity: same store, same time, same device (MZY-294). */
export function sampleKey(record: {
  tMs?: unknown;
  deviceId?: unknown;
}): string {
  return `${String(record.tMs)}|${String(record.deviceId ?? '')}`;
}

type SampleStore = Exclude<JournalStore, 'recordings'>;

export interface ReplayPlan {
  /** The newest journaled header, when IndexedDB lacks it or is behind it. */
  header: Record<string, unknown> | null;
  /** Journaled samples IndexedDB doesn't have, per store. */
  missing: Partial<Record<SampleStore, Array<Record<string, unknown>>>>;
  missingCount: number;
}

/**
 * What to write back into IndexedDB for one recording. `stored` holds the
 * sample keys IndexedDB already has per store; `storedHeader` its header.
 * A header only moves forward: a journaled 'stopped' replaces a stored
 * 'recording', never the other way round, and 'flushed' is never touched.
 */
export function planReplay(
  entries: readonly JournalEntry[],
  stored: Partial<Record<SampleStore, ReadonlySet<string>>>,
  storedHeader: { status?: unknown } | null,
): ReplayPlan {
  let header: Record<string, unknown> | null = null;
  const missing: ReplayPlan['missing'] = {};
  const seen = new Map<SampleStore, Set<string>>();
  let missingCount = 0;
  for (const { store, record } of entries) {
    if (store === 'recordings') {
      header = record; // later lines are later states
      continue;
    }
    const key = sampleKey(record);
    const known = seen.get(store) ?? new Set(stored[store] ?? []);
    seen.set(store, known);
    if (known.has(key)) continue;
    known.add(key);
    (missing[store] ??= []).push(record);
    missingCount++;
  }
  const rank = (s: unknown) =>
    s === 'flushed' ? 2 : s === 'stopped' ? 1 : s === 'recording' ? 0 : -1;
  if (
    header &&
    storedHeader &&
    rank(header.status) <= rank(storedHeader.status)
  ) {
    header = null;
  }
  return { header, missing, missingCount };
}
