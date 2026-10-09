import {
  applyLocal,
  applyPulled,
  live,
  type ReplicaTables,
} from '@/lib/sync/replicaState';

describe('applyPulled', () => {
  it('server rows replace the local copy wholesale', () => {
    const tables: ReplicaTables = {};
    applyLocal(tables, [
      {
        table: 'meal_logs',
        id: 'm',
        values: { notes: 'local', meal_slot: 'lunch' },
      },
    ]);
    const touched = applyPulled(
      tables,
      [
        {
          table: 'meal_logs',
          seq: 5,
          row: { id: 'm', notes: 'merged', meal_slot: 'dinner' },
        },
      ],
      [],
    );
    expect(tables.meal_logs!.get('m')).toEqual({
      id: 'm',
      notes: 'merged',
      meal_slot: 'dinner',
    });
    expect(touched.put).toEqual({ meal_logs: ['m'] });
  });

  it('an alias removes the duplicate local row', () => {
    const tables: ReplicaTables = {};
    applyLocal(tables, [
      { table: 'medications', id: 'mine', values: { name: 'Mg' } },
    ]);
    const touched = applyPulled(
      tables,
      [{ table: 'medications', seq: 9, row: { id: 'canonical', name: 'Mg' } }],
      [{ aliasId: 'mine', table: 'medications', canonicalId: 'canonical' }],
    );
    expect([...tables.medications!.keys()]).toEqual(['canonical']);
    expect(touched.removed).toEqual({ medications: ['mine'] });
  });
});

describe('applyLocal', () => {
  it('lays only the written fields over an existing row', () => {
    const tables: ReplicaTables = {};
    applyPulled(
      tables,
      [
        {
          table: 'meal_logs',
          seq: 1,
          row: {
            id: 'm',
            notes: null,
            meal_slot: 'breakfast',
            date: '2026-09-24',
          },
        },
      ],
      [],
    );
    applyLocal(tables, [
      {
        table: 'meal_logs',
        id: 'm',
        values: { meal_slot: 'lunch', ignored: undefined },
      },
    ]);
    expect(tables.meal_logs!.get('m')).toEqual({
      id: 'm',
      notes: null,
      meal_slot: 'lunch',
      date: '2026-09-24',
    });
  });

  it('a local tombstone hides the row from live()', () => {
    const tables: ReplicaTables = {};
    applyLocal(tables, [
      { table: 'meal_logs', id: 'm', values: { date: '2026-09-24' } },
    ]);
    applyLocal(tables, [
      {
        table: 'meal_logs',
        id: 'm',
        values: { deleted_at: '2026-09-24T21:00:00Z' },
      },
    ]);
    expect(live(tables, 'meal_logs')).toEqual([]);
    expect(live(tables, 'unknown_table')).toEqual([]);
  });
});
