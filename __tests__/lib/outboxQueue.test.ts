import {
  classifyResponse,
  flushBatches,
  flushOrder,
  flushQueue,
  groupEntries,
  mutationsForRows,
  newMutationEntries,
  pendingRows,
  requestBody,
  type MutationEntry,
  type OutboxEntry,
  type OutboxStore,
  type RequestEntry,
  type SendResult,
} from '@/lib/outboxQueue';

const HLC = '001790000000000:000000:phone';
let n = 0;
const newId = () => `e${++n}`;

function meal(
  group: string,
  firstSeq: number,
  fields: Record<string, unknown>,
): MutationEntry[] {
  return newMutationEntries({
    group,
    label: `meal ${group}`,
    capturedAt: '2026-09-24T21:30:00.000Z',
    firstSeq,
    mutations: mutationsForRows(
      [{ table: 'meal_logs', id: `row-${group}`, values: fields }],
      HLC,
    ),
    newId,
  });
}

function legacy(seq: number, over: Partial<RequestEntry> = {}): RequestEntry {
  return {
    id: `legacy-${seq}`,
    seq,
    endpoint: '/api/nutrition/log',
    method: 'POST',
    body: { mode: 'adhoc' },
    label: 'legacy',
    capturedAt: '2026-03-01T22:30:00.000Z',
    attempts: 0,
    status: 'pending',
    lastError: null,
    ...over,
  };
}

class MemoryStore implements OutboxStore {
  constructor(public entries: OutboxEntry[]) {}
  async list() {
    return [...this.entries];
  }
  async put(e: OutboxEntry) {
    this.entries = [...this.entries.filter((x) => x.id !== e.id), e];
  }
  async remove(id: string) {
    this.entries = this.entries.filter((x) => x.id !== id);
  }
  get(id: string) {
    return this.entries.find((e) => e.id === id);
  }
}

/** A fake server: per batch, either an HTTP failure or per-mutation verdicts. */
function fakeServer(
  script: (batch: OutboxEntry[], call: number) => SendResult,
) {
  const calls: string[][] = [];
  const send = async (batch: OutboxEntry[]) => {
    calls.push(batch.map((e) => e.id));
    return script(batch, calls.length);
  };
  return { send, calls };
}
const allApplied = (batch: OutboxEntry[]): SendResult => ({
  status: 200,
  error: null,
  results: batch.map(() => ({ status: 'applied' as const })),
});

describe('classifyResponse', () => {
  it.each([
    [201, 'done'],
    [200, 'done'],
    ['network-error', 'retry'],
    [500, 'retry'],
    [503, 'retry'],
    [429, 'retry'],
    [408, 'retry'],
    [401, 'auth'],
    [400, 'failed'],
    [404, 'failed'],
  ] as const)('%s -> %s', (status, outcome) => {
    expect(classifyResponse(status)).toBe(outcome);
  });
});

describe('mutationsForRows', () => {
  it('one human mutation per defined field, all with the action HLC', () => {
    expect(
      mutationsForRows(
        [
          {
            table: 'meal_logs',
            id: 'm1',
            values: { meal_slot: 'lunch', notes: null, x: undefined },
          },
        ],
        HLC,
      ),
    ).toEqual([
      {
        table: 'meal_logs',
        id: 'm1',
        field: 'meal_slot',
        value: 'lunch',
        hlc: HLC,
        origin: 'human',
      },
      {
        table: 'meal_logs',
        id: 'm1',
        field: 'notes',
        value: null,
        hlc: HLC,
        origin: 'human',
      },
    ]);
  });
});

describe('flushOrder / flushBatches', () => {
  it('is FIFO by seq and skips failed entries', () => {
    const [a, b, c] = meal('g', 1, { a: 1, b: 2, c: 3 });
    const order = flushOrder([c!, { ...a!, status: 'failed' }, b!]);
    expect(order.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('batches consecutive mutations, sends a legacy entry alone, keeps order', () => {
    const early = meal('a', 1, { x: 1, y: 2, z: 3 }); // seq 1..3
    const late = meal('b', 10, { x: 1 }); // seq 10
    const batches = flushBatches([...late, legacy(5), ...early], 2);
    expect(batches.map((b) => b.map((e) => e.seq))).toEqual([
      [1, 2],
      [3],
      [5],
      [10],
    ]);
  });
});

describe('requestBody (legacy entries)', () => {
  it('merges clientId + capturedAt into the stored body; no body for a bare DELETE', () => {
    expect(JSON.parse(requestBody(legacy(1))!)).toEqual({
      mode: 'adhoc',
      clientId: 'legacy-1',
      capturedAt: '2026-03-01T22:30:00.000Z',
    });
    expect(
      requestBody(legacy(1, { method: 'DELETE', body: null })),
    ).toBeUndefined();
  });
});

describe('flushQueue', () => {
  it('delivers a whole action in one push and empties the queue', async () => {
    const store = new MemoryStore(
      meal('g', 1, { meal_slot: 'lunch', notes: 'x' }),
    );
    const { send, calls } = fakeServer(allApplied);
    const report = await flushQueue(store, send);
    expect(calls).toHaveLength(1);
    expect(report.delivered).toHaveLength(2);
    expect(store.entries).toEqual([]);
  });

  it('treats "skipped" (lost the merge, or a replay) as final — the entry is removed', async () => {
    const store = new MemoryStore(meal('g', 1, { notes: 'x' }));
    await flushQueue(
      store,
      fakeServer((b) => ({
        status: 200,
        error: null,
        results: b.map(() => ({ status: 'skipped' as const })),
      })).send,
    );
    expect(store.entries).toEqual([]);
  });

  it('parks a rejected mutation as failed while its siblings are delivered', async () => {
    const entries = meal('g', 1, { meal_slot: 'brunch', notes: 'x' });
    const store = new MemoryStore(entries);
    const report = await flushQueue(
      store,
      fakeServer(() => ({
        status: 200,
        error: null,
        results: [
          { status: 'rejected', error: 'bad meal_slot' },
          { status: 'applied' },
        ],
      })).send,
    );
    expect(report.failed).toEqual([entries[0]!.id]);
    expect(store.get(entries[0]!.id)).toMatchObject({
      status: 'failed',
      lastError: 'bad meal_slot',
    });
    expect(store.entries).toHaveLength(1);
  });

  it('stops at an offline batch so nothing overtakes it; a later flush resumes', async () => {
    const store = new MemoryStore([
      ...meal('a', 1, { x: 1 }),
      ...meal('b', 2, { x: 2 }),
    ]);
    const offline = fakeServer((_, call) =>
      call === 2
        ? { status: 'network-error', error: 'offline' }
        : allApplied(_),
    );
    const report = await flushQueue(store, offline.send, 1);
    expect(report.stoppedBy).toBe('retry');
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).toMatchObject({ status: 'pending', attempts: 1 });

    const leftover = store.entries[0]!.id;
    const { send, calls } = fakeServer(allApplied);
    await flushQueue(store, send);
    expect(calls).toEqual([[leftover]]); // only what was left, not the delivered one
    expect(store.entries).toEqual([]);
  });

  it('keeps writes on a 401 and reports auth, so they flush after sign-in', async () => {
    const store = new MemoryStore(meal('g', 1, { x: 1, y: 2 }));
    const report = await flushQueue(
      store,
      fakeServer(() => ({ status: 401, error: 'authentication required' }))
        .send,
    );
    expect(report.stoppedBy).toBe('auth');
    expect(store.entries.every((e) => e.status === 'pending')).toBe(true);
  });

  it('a whole-batch 400 fails that batch and carries on', async () => {
    const store = new MemoryStore([
      ...meal('a', 1, { x: 1 }),
      ...meal('b', 2, { x: 2 }),
    ]);
    const report = await flushQueue(
      store,
      fakeServer((b, call) =>
        call === 1 ? { status: 400, error: 'invalid body' } : allApplied(b),
      ).send,
      1,
    );
    expect(report.failed).toHaveLength(1);
    expect(report.delivered).toHaveLength(1);
  });

  it('still drains a phase-1 request entry queued before the upgrade', async () => {
    const store = new MemoryStore([legacy(1), ...meal('g', 2, { x: 1 })]);
    const { send, calls } = fakeServer((b) =>
      b[0]!.kind === 'mutation' ? allApplied(b) : { status: 201, error: null },
    );
    await flushQueue(store, send);
    expect(calls[0]).toEqual(['legacy-1']);
    expect(store.entries).toEqual([]);
  });

  it('never re-sends a failed entry until it is reset to pending, and never re-stamps capturedAt', async () => {
    const [e] = meal('g', 1, { x: 1 });
    const store = new MemoryStore([{ ...e!, status: 'failed' }]);
    const { send, calls } = fakeServer(allApplied);
    await flushQueue(store, send);
    expect(calls).toEqual([]);
    expect(store.entries[0]!.capturedAt).toBe('2026-09-24T21:30:00.000Z');
  });
});

describe('groupEntries', () => {
  it('one line per action; failed if any part failed; legacy entries are their own group', () => {
    const a = meal('a', 1, { x: 1, y: 2 });
    const groups = groupEntries([
      ...a.slice(0, 1),
      { ...a[1]!, status: 'failed', lastError: 'nope' },
      legacy(5),
    ]);
    expect(
      groups.map((g) => [g.group, g.status, g.entryIds.length, g.lastError]),
    ).toEqual([
      ['a', 'failed', 2, 'nope'],
      ['legacy-5', 'pending', 1, null],
    ]);
  });
});

describe('pendingRows', () => {
  it('folds pending + failed mutation entries back into rows, later writes winning; skips legacy entries', () => {
    const first = meal('a', 1, { meal_slot: 'lunch', notes: 'x' });
    const later = meal('a', 5, { notes: 'y' });
    expect(pendingRows([...later, legacy(3), ...first])).toEqual([
      {
        table: 'meal_logs',
        id: 'row-a',
        values: { meal_slot: 'lunch', notes: 'y' },
      },
    ]);
  });
});
