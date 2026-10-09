// Local write-ahead buffer for app/record (CLAUDE.md "Live Run Recording"): every
// sample is written to IndexedDB as it arrives, independent of network state,
// so a dropped connection or dead zone never loses data — then flushed to
// Postgres run_streams/ride_streams on stop (services/liveRecording.ts,
// services/liveRecordingRide.ts) once connectivity allows. One object store per
// metric (mirrors run_streams/ride_streams themselves, which keep a separate
// typed array per metric under one row): the original pass wrote only
// `hr_samples`; MZY-168 (Garmin Speed Sensor 2 / Cadence Sensor 2 over BLE CSC,
// see lib/bluetoothCycling.ts) adds `speed_samples`/`cadence_samples` — names
// this file had already reserved but never created. MZY-270 (BLE Cycling
// Power, lib/bluetoothPower.ts) adds `power_samples` in DB version 3; MZY-281
// (the Android app's GPS, lib/gps/) adds `gps_samples` in version 4. The
// upgrade only creates missing stores, so an older install keeps its buffered
// recordings.
//
// In the Android app every write is also journaled natively (MZY-294,
// lib/sampleJournal.ts) — synchronously, BEFORE the IndexedDB await, because
// the hidden WebView queues IndexedDB writes in memory and a process death
// loses them. replayJournals() writes back what IndexedDB is missing.
//
// The IndexedDB-touching functions below are integration surface (no fake-idb in
// this repo) and are exercised live, not unit-tested. The pure stream builders
// and summaries live in lib/liveRecordingStreams.ts.

import type { SampleDevice } from './sourceDevices';
import {
  journalAppend,
  journalClear,
  journalRead,
  journalRecordingIds,
  parseJournal,
  planReplay,
  sampleKey,
  type JournalStore,
} from './sampleJournal';

const DB_NAME = 'agon-live-recording';
const DB_VERSION = 4;
const RECORDINGS_STORE = 'recordings';
const HR_SAMPLES_STORE = 'hr_samples';
const SPEED_SAMPLES_STORE = 'speed_samples';
const CADENCE_SAMPLES_STORE = 'cadence_samples';
const POWER_SAMPLES_STORE = 'power_samples';
const GPS_SAMPLES_STORE = 'gps_samples';

export type RecordingStatus = 'recording' | 'stopped' | 'flushed';

/** Which finish endpoint (and which sample stores) a recording flushes through — see MZY-168. */
export type ActivityType = 'run' | 'ride';

export interface RecordingHeader {
  id: string;
  startedAt: number; // epoch ms
  endedAt: number | null; // epoch ms
  status: RecordingStatus;
  deviceName: string;
  // Optional for backward compat: a header written before MZY-168 has no such
  // field on disk — every call site treats a missing value as 'run', the only
  // activity type that existed then.
  activityType?: ActivityType;
}

// Every sample may carry the BLE device that produced it (SampleDevice,
// MZY-271) — absent on samples buffered before that.
export interface HrSampleRecord extends SampleDevice {
  recordingId: string;
  tMs: number; // absolute epoch ms — not elapsed, so ordering/resume is trivial
  bpm: number;
  sensorContact: string;
}

export interface SpeedSampleRecord extends SampleDevice {
  recordingId: string;
  tMs: number; // absolute epoch ms
  speedKmh: number; // instantaneous, from lib/bluetoothCycling.ts computeWheelSpeedKmh
  // The sensor's cumulative wheel-revolution counter (uint32) at this frame —
  // the ride's distance fallback when there's no GPS track (MZY-282).
  // Absent on samples buffered before that.
  wheelRevs?: number;
}

export interface CadenceSampleRecord extends SampleDevice {
  recordingId: string;
  tMs: number; // absolute epoch ms
  rpm: number; // instantaneous, from lib/bluetoothCycling.ts computeCadenceRpm
}

export interface PowerSampleRecord extends SampleDevice {
  recordingId: string;
  tMs: number; // absolute epoch ms
  watts: number; // instantaneous, DEVICE-measured (lib/bluetoothPower.ts), clamped ≥ 0
}

// One ACCEPTED location fix (lib/gpsTrack.ts filters at write time), stamped
// with PHONE_GPS_DEVICE (lib/gps/source.ts).
export interface GpsSampleRecord extends SampleDevice {
  recordingId: string;
  tMs: number; // absolute epoch ms — the fix's own time, not arrival time
  lat: number;
  lng: number;
  altitudeM: number | null;
  accuracyM: number;
  speedMps: number | null;
}

function createSampleStore(db: IDBDatabase, name: string): void {
  if (db.objectStoreNames.contains(name)) return;
  const store = db.createObjectStore(name, {
    keyPath: 'sampleId',
    autoIncrement: true,
  });
  store.createIndex('recordingId', 'recordingId', { unique: false });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECORDINGS_STORE)) {
        db.createObjectStore(RECORDINGS_STORE, { keyPath: 'id' });
      }
      createSampleStore(db, HR_SAMPLES_STORE);
      createSampleStore(db, SPEED_SAMPLES_STORE);
      createSampleStore(db, CADENCE_SAMPLES_STORE);
      createSampleStore(db, POWER_SAMPLES_STORE);
      createSampleStore(db, GPS_SAMPLES_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export async function createRecording(
  deviceName: string,
  activityType: ActivityType = 'run',
): Promise<RecordingHeader> {
  const header: RecordingHeader = {
    id: crypto.randomUUID(),
    startedAt: Date.now(),
    endedAt: null,
    status: 'recording',
    deviceName,
    activityType,
  };
  journalAppend(header.id, RECORDINGS_STORE, header);
  const db = await openDb();
  const tx = db.transaction(RECORDINGS_STORE, 'readwrite');
  await promisifyRequest(tx.objectStore(RECORDINGS_STORE).add(header));
  return header;
}

export async function appendHrSample(sample: HrSampleRecord): Promise<void> {
  journalAppend(sample.recordingId, HR_SAMPLES_STORE, sample);
  const db = await openDb();
  const tx = db.transaction(HR_SAMPLES_STORE, 'readwrite');
  await promisifyRequest(tx.objectStore(HR_SAMPLES_STORE).add(sample));
}

export async function appendSpeedSample(sample: SpeedSampleRecord): Promise<void> {
  journalAppend(sample.recordingId, SPEED_SAMPLES_STORE, sample);
  const db = await openDb();
  const tx = db.transaction(SPEED_SAMPLES_STORE, 'readwrite');
  await promisifyRequest(tx.objectStore(SPEED_SAMPLES_STORE).add(sample));
}

export async function appendCadenceSample(sample: CadenceSampleRecord): Promise<void> {
  journalAppend(sample.recordingId, CADENCE_SAMPLES_STORE, sample);
  const db = await openDb();
  const tx = db.transaction(CADENCE_SAMPLES_STORE, 'readwrite');
  await promisifyRequest(tx.objectStore(CADENCE_SAMPLES_STORE).add(sample));
}

export async function appendPowerSample(sample: PowerSampleRecord): Promise<void> {
  journalAppend(sample.recordingId, POWER_SAMPLES_STORE, sample);
  const db = await openDb();
  const tx = db.transaction(POWER_SAMPLES_STORE, 'readwrite');
  await promisifyRequest(tx.objectStore(POWER_SAMPLES_STORE).add(sample));
}

export async function appendGpsSample(sample: GpsSampleRecord): Promise<void> {
  journalAppend(sample.recordingId, GPS_SAMPLES_STORE, sample);
  const db = await openDb();
  const tx = db.transaction(GPS_SAMPLES_STORE, 'readwrite');
  await promisifyRequest(tx.objectStore(GPS_SAMPLES_STORE).add(sample));
}

export async function stopRecording(
  recordingId: string,
  endedAt: number = Date.now(),
): Promise<RecordingHeader> {
  const db = await openDb();
  const tx = db.transaction(RECORDINGS_STORE, 'readwrite');
  const store = tx.objectStore(RECORDINGS_STORE);
  const header = (await promisifyRequest(
    store.get(recordingId) as IDBRequest<RecordingHeader | undefined>,
  )) ?? null;
  if (!header) throw new Error(`recording ${recordingId} not found`);
  const updated: RecordingHeader = { ...header, endedAt, status: 'stopped' };
  journalAppend(recordingId, RECORDINGS_STORE, updated);
  await promisifyRequest(store.put(updated));
  return updated;
}

/** Recordings that haven't been successfully flushed yet — the resume/retry entry point. */
export async function listUnflushedRecordings(): Promise<RecordingHeader[]> {
  const db = await openDb();
  const tx = db.transaction(RECORDINGS_STORE, 'readonly');
  const all = await promisifyRequest(
    tx.objectStore(RECORDINGS_STORE).getAll() as IDBRequest<RecordingHeader[]>,
  );
  return all.filter((r) => r.status !== 'flushed');
}

export async function getHrSamples(recordingId: string): Promise<HrSampleRecord[]> {
  const db = await openDb();
  const tx = db.transaction(HR_SAMPLES_STORE, 'readonly');
  const index = tx.objectStore(HR_SAMPLES_STORE).index('recordingId');
  const samples = await promisifyRequest(
    index.getAll(recordingId) as IDBRequest<HrSampleRecord[]>,
  );
  return [...samples].sort((a, b) => a.tMs - b.tMs);
}

export async function getSpeedSamples(recordingId: string): Promise<SpeedSampleRecord[]> {
  const db = await openDb();
  const tx = db.transaction(SPEED_SAMPLES_STORE, 'readonly');
  const index = tx.objectStore(SPEED_SAMPLES_STORE).index('recordingId');
  const samples = await promisifyRequest(
    index.getAll(recordingId) as IDBRequest<SpeedSampleRecord[]>,
  );
  return [...samples].sort((a, b) => a.tMs - b.tMs);
}

export async function getCadenceSamples(recordingId: string): Promise<CadenceSampleRecord[]> {
  const db = await openDb();
  const tx = db.transaction(CADENCE_SAMPLES_STORE, 'readonly');
  const index = tx.objectStore(CADENCE_SAMPLES_STORE).index('recordingId');
  const samples = await promisifyRequest(
    index.getAll(recordingId) as IDBRequest<CadenceSampleRecord[]>,
  );
  return [...samples].sort((a, b) => a.tMs - b.tMs);
}

export async function getPowerSamples(recordingId: string): Promise<PowerSampleRecord[]> {
  const db = await openDb();
  const tx = db.transaction(POWER_SAMPLES_STORE, 'readonly');
  const index = tx.objectStore(POWER_SAMPLES_STORE).index('recordingId');
  const samples = await promisifyRequest(
    index.getAll(recordingId) as IDBRequest<PowerSampleRecord[]>,
  );
  return [...samples].sort((a, b) => a.tMs - b.tMs);
}

export async function getGpsSamples(recordingId: string): Promise<GpsSampleRecord[]> {
  const db = await openDb();
  const tx = db.transaction(GPS_SAMPLES_STORE, 'readonly');
  const index = tx.objectStore(GPS_SAMPLES_STORE).index('recordingId');
  const samples = await promisifyRequest(
    index.getAll(recordingId) as IDBRequest<GpsSampleRecord[]>,
  );
  return [...samples].sort((a, b) => a.tMs - b.tMs);
}

const SAMPLE_STORES: Array<Exclude<JournalStore, 'recordings'>> = [
  HR_SAMPLES_STORE,
  SPEED_SAMPLES_STORE,
  CADENCE_SAMPLES_STORE,
  POWER_SAMPLES_STORE,
  GPS_SAMPLES_STORE,
];

/** Deletes every buffered sample for `recordingId` across all metric stores. */
async function deleteAllSamples(db: IDBDatabase, recordingId: string): Promise<void> {
  await Promise.all(
    SAMPLE_STORES.map(async (storeName) => {
      const tx = db.transaction(storeName, 'readwrite');
      const index = tx.objectStore(storeName).index('recordingId');
      const keys = await promisifyRequest(
        index.getAllKeys(recordingId) as IDBRequest<IDBValidKey[]>,
      );
      await Promise.all(keys.map((key) => promisifyRequest(tx.objectStore(storeName).delete(key))));
    }),
  );
}

/** Marks a recording flushed and drops its raw samples; the header row stays as a debug trail. */
export async function markFlushed(recordingId: string): Promise<void> {
  const db = await openDb();
  const recTx = db.transaction(RECORDINGS_STORE, 'readwrite');
  const store = recTx.objectStore(RECORDINGS_STORE);
  const header = (await promisifyRequest(
    store.get(recordingId) as IDBRequest<RecordingHeader | undefined>,
  )) ?? null;
  if (header) await promisifyRequest(store.put({ ...header, status: 'flushed' }));

  await deleteAllSamples(db, recordingId);
  await journalClear(recordingId); // Postgres has it now
}

/** Deletes a recording's header and any buffered samples without flushing — for a zero-sample or athlete-cancelled recording. */
export async function discardRecording(recordingId: string): Promise<void> {
  const db = await openDb();
  const recTx = db.transaction(RECORDINGS_STORE, 'readwrite');
  await promisifyRequest(recTx.objectStore(RECORDINGS_STORE).delete(recordingId));

  await deleteAllSamples(db, recordingId);
  await journalClear(recordingId);
}

/**
 * Writes back the journaled samples (and header) IndexedDB is missing — after
 * a process death while the page was hidden (MZY-294). `only` limits it to
 * one recording (the flush); `skip` leaves the live one alone, whose
 * IndexedDB writes may still be in flight. Dedupe is by (store, tMs,
 * deviceId); a duplicate that slips through is harmless — the flush buckets
 * samples to 1 s and the last one wins. Returns the samples restored.
 */
export async function replayJournals(
  opts: { only?: string; skip?: string | null } = {},
): Promise<number> {
  const ids = opts.only ? [opts.only] : await journalRecordingIds();
  let restored = 0;
  for (const id of ids) {
    if (id === opts.skip) continue;
    const entries = parseJournal(await journalRead(id));
    if (entries.length === 0) continue;
    const db = await openDb();
    const recTx = db.transaction(RECORDINGS_STORE, 'readonly');
    const storedHeader = (await promisifyRequest(
      recTx.objectStore(RECORDINGS_STORE).get(id) as IDBRequest<RecordingHeader | undefined>,
    )) ?? null;
    if (storedHeader?.status === 'flushed') {
      await journalClear(id); // flushed, but the clear never ran
      continue;
    }
    const stored: Partial<Record<Exclude<JournalStore, 'recordings'>, Set<string>>> = {};
    for (const storeName of SAMPLE_STORES) {
      const index = db.transaction(storeName, 'readonly').objectStore(storeName).index('recordingId');
      const have = await promisifyRequest(
        index.getAll(id) as IDBRequest<Array<{ tMs: number; deviceId?: string }>>,
      );
      stored[storeName] = new Set(have.map(sampleKey));
    }
    const plan = planReplay(entries, stored, storedHeader);
    if (plan.header) {
      const tx = db.transaction(RECORDINGS_STORE, 'readwrite');
      await promisifyRequest(tx.objectStore(RECORDINGS_STORE).put(plan.header));
    }
    for (const [storeName, records] of Object.entries(plan.missing)) {
      const tx = db.transaction(storeName, 'readwrite');
      await Promise.all(records.map((r) => promisifyRequest(tx.objectStore(storeName).add(r))));
    }
    restored += plan.missingCount;
  }
  return restored;
}
