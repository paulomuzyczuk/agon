import {
  journalAppend,
  journalRead,
  parseJournal,
  planReplay,
  sampleKey,
} from '../../lib/sampleJournal';

const hr = (tMs: number, deviceId = '00:00:5E:00:53:01') => ({
  recordingId: 'rec-1',
  tMs,
  bpm: 140,
  sensorContact: 'supported-detected',
  deviceId,
});

const line = (s: string, d: object) => JSON.stringify({ s, d });

describe('parseJournal', () => {
  it('reads one entry per line and skips a torn last line', () => {
    const text = [
      line('recordings', { id: 'rec-1', status: 'recording' }),
      line('hr_samples', hr(1000)),
      line('gps_samples', { tMs: 1000, lat: 52.5, lng: 13.4 }),
      '{"s":"hr_samples","d":{"tMs":20', // killed mid-write
    ].join('\n');
    const entries = parseJournal(text);
    expect(entries.map((e) => e.store)).toEqual([
      'recordings',
      'hr_samples',
      'gps_samples',
    ]);
    expect(entries[1]!.record).toEqual(hr(1000));
  });

  it('ignores unknown stores, non-object records and blank lines', () => {
    const text = [
      line('evil_store', hr(1)),
      JSON.stringify({ s: 'hr_samples', d: 5 }),
      '',
      line('hr_samples', hr(2)),
      '',
    ].join('\n');
    expect(parseJournal(text)).toHaveLength(1);
  });
});

describe('planReplay', () => {
  const entries = parseJournal(
    [
      line('recordings', { id: 'rec-1', status: 'recording', startedAt: 0 }),
      line('hr_samples', hr(1000)),
      line('hr_samples', hr(1500)),
      line('hr_samples', hr(1500, 'other-strap')),
      line('hr_samples', hr(1500)), // a duplicate line
      line('gps_samples', { tMs: 1000, deviceId: 'phone-gps', lat: 1, lng: 2 }),
    ].join('\n'),
  );

  it('returns only what IndexedDB is missing, deduped by (store, tMs, device)', () => {
    const plan = planReplay(
      entries,
      { hr_samples: new Set([sampleKey(hr(1000))]) },
      { status: 'recording' },
    );
    expect(plan.missing.hr_samples?.map((r) => [r.tMs, r.deviceId])).toEqual([
      [1500, '00:00:5E:00:53:01'],
      [1500, 'other-strap'],
    ]);
    expect(plan.missing.gps_samples).toHaveLength(1);
    expect(plan.missingCount).toBe(3);
  });

  it('restores a header IndexedDB never committed', () => {
    const plan = planReplay(entries, {}, null);
    expect(plan.header).toMatchObject({ id: 'rec-1', status: 'recording' });
  });

  it('moves a header forward only, never back', () => {
    const stopped = parseJournal(
      [
        line('recordings', { id: 'rec-1', status: 'recording' }),
        line('recordings', { id: 'rec-1', status: 'stopped', endedAt: 9 }),
      ].join('\n'),
    );
    expect(
      planReplay(stopped, {}, { status: 'recording' }).header,
    ).toMatchObject({ status: 'stopped', endedAt: 9 });
    expect(planReplay(stopped, {}, { status: 'stopped' }).header).toBeNull();
    expect(planReplay(entries, {}, { status: 'stopped' }).header).toBeNull();
  });

  it('a pre-MZY-271 sample without a device still dedupes', () => {
    const plain = { recordingId: 'rec-1', tMs: 7, bpm: 120 };
    const plan = planReplay(
      parseJournal(line('hr_samples', plain)),
      { hr_samples: new Set([sampleKey(plain)]) },
      { status: 'recording' },
    );
    expect(plan.missingCount).toBe(0);
  });
});

describe('outside the Android app', () => {
  it('journaling is a no-op', async () => {
    expect(() => journalAppend('rec-1', 'hr_samples', hr(1))).not.toThrow();
    await expect(journalRead('rec-1')).resolves.toBe('');
  });
});
