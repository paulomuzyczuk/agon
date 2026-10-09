import { formatHlc } from '@/lib/sync/hlc';
import { mergeField, mergeRow, type FieldStamp } from '@/lib/sync/mergeField';

const T = 1_790_000_000_000;
const hlc = (msAfter: number, node = 'phone', counter = 0) =>
  formatHlc({ wall: T + msAfter, counter, node });
const human = (msAfter: number, node = 'phone', counter = 0): FieldStamp => ({
  hlc: hlc(msAfter, node, counter),
  origin: 'human',
});
const machine = (msAfter: number, node = 'server', counter = 0): FieldStamp => ({
  hlc: hlc(msAfter, node, counter),
  origin: 'machine',
});

describe('mergeField', () => {
  it('applies to a field that has never been stamped', () => {
    expect(mergeField(undefined, human(0))).toBe(true);
    expect(mergeField(undefined, machine(0))).toBe(true);
  });

  it('later HLC wins between humans (both directions)', () => {
    expect(mergeField(human(0, 'phone'), human(10, 'laptop'))).toBe(true);
    expect(mergeField(human(10, 'laptop'), human(0, 'phone'))).toBe(false);
  });

  it('later HLC wins between machines', () => {
    expect(mergeField(machine(0), machine(10))).toBe(true);
    expect(mergeField(machine(10), machine(0))).toBe(false);
  });

  it('human beats machine regardless of clock', () => {
    // A lab re-import stamped a day later still loses to the hand correction.
    expect(mergeField(human(0), machine(86_400_000))).toBe(false);
    // A hand edit with an older (skewed) clock still beats the machine value.
    expect(mergeField(machine(86_400_000), human(0))).toBe(true);
  });

  it('exact same stamp is a replay, not a change (idempotent push)', () => {
    expect(mergeField(human(5), human(5))).toBe(false);
  });

  it('breaks an exact wall+counter tie on node id, the same way on every replica', () => {
    const a = human(5, 'aaa');
    const b = human(5, 'bbb');
    expect(mergeField(a, b)).toBe(true);
    expect(mergeField(b, a)).toBe(false);
  });

  it('same-ms edits on one device are ordered by counter', () => {
    expect(mergeField(human(5, 'phone', 0), human(5, 'phone', 1))).toBe(true);
    expect(mergeField(human(5, 'phone', 1), human(5, 'phone', 0))).toBe(false);
  });
});

describe('mergeRow — concurrent devices', () => {
  it('different fields edited on two devices both survive, in either arrival order', () => {
    const fromPhone = { field: 'meal_slot', value: 'lunch', stamp: human(10, 'phone') };
    const fromLaptop = { field: 'notes', value: 'extra honey', stamp: human(5, 'laptop') };

    const phoneFirst = mergeRow({}, [fromPhone, fromLaptop]);
    const laptopFirst = mergeRow({}, [fromLaptop, fromPhone]);
    expect(phoneFirst.apply).toEqual({ meal_slot: 'lunch', notes: 'extra honey' });
    expect(laptopFirst.apply).toEqual(phoneFirst.apply);
    expect(laptopFirst.stamps).toEqual(phoneFirst.stamps);
  });

  it('same field on two devices converges on the later HLC, whichever syncs first', () => {
    const early = { field: 'notes', value: 'early', stamp: human(1, 'phone') };
    const late = { field: 'notes', value: 'late', stamp: human(2, 'laptop') };

    // Server state after both orders:
    const a = mergeRow(mergeRow({}, [early]).stamps, [late]);
    const b = mergeRow(mergeRow({}, [late]).stamps, [early]);
    expect(a.apply).toEqual({ notes: 'late' });
    expect(b.apply).toEqual({}); // early arrives second and loses
    expect(b.skipped).toEqual(['notes']);
    expect(a.stamps.notes).toEqual(b.stamps.notes);
  });

  it('a device with a clock hours behind loses a same-field race it was actually later in', () => {
    // Documented LWW trade-off: HLC fixes causality it has seen, not raw skew
    // between devices that never exchanged stamps. (A fast clock is clamped
    // server-side — see clampHlc.)
    const laggingButLater = { field: 'notes', value: 'b', stamp: human(-3_600_000, 'slow') };
    const current = { notes: human(0, 'fast') };
    expect(mergeRow(current, [laggingButLater]).apply).toEqual({});
  });

  it('a replayed batch changes nothing', () => {
    const batch = [
      { field: 'notes', value: 'x', stamp: human(1) },
      { field: 'meal_slot', value: 'dinner', stamp: human(2) },
    ];
    const first = mergeRow({}, batch);
    const replay = mergeRow(first.stamps, batch);
    expect(replay.apply).toEqual({});
    expect(replay.stamps).toEqual(first.stamps);
  });

  it('multiple writes to one field in one batch fold in order', () => {
    const r = mergeRow({}, [
      { field: 'notes', value: 'a', stamp: human(1) },
      { field: 'notes', value: 'b', stamp: human(2) },
      { field: 'notes', value: 'stale', stamp: human(0) },
    ]);
    expect(r.apply).toEqual({ notes: 'b' });
    expect(r.skipped).toEqual(['notes']);
  });
});

describe('mergeRow — human vs machine', () => {
  it('a machine re-import cannot overwrite a hand-corrected field, but can update others', () => {
    const afterHandFix = { value_numeric: human(100), unit: machine(0) };
    const reimport = mergeRow(afterHandFix, [
      { field: 'value_numeric', value: 12.3, stamp: machine(200) },
      { field: 'unit', value: 'nmol/L', stamp: machine(200) },
    ]);
    expect(reimport.apply).toEqual({ unit: 'nmol/L' });
    expect(reimport.skipped).toEqual(['value_numeric']);
    expect(reimport.stamps.value_numeric).toEqual(afterHandFix.value_numeric);
  });
});

describe('mergeRow — delete vs edit', () => {
  const del = (ms: number, node = 'phone') => ({
    field: 'deleted_at',
    value: new Date(T + ms).toISOString(),
    stamp: human(ms, node),
  });

  it('a delete and a concurrent edit of another field both apply (row stays deleted)', () => {
    const r = mergeRow({}, [del(10, 'phone'), { field: 'notes', value: 'edit', stamp: human(20, 'laptop') }]);
    expect(Object.keys(r.apply).sort()).toEqual(['deleted_at', 'notes']);
  });

  it('an older restore does not undo a newer delete', () => {
    const afterDelete = mergeRow({}, [del(10)]).stamps;
    const staleRestore = { field: 'deleted_at', value: null, stamp: human(5, 'laptop') };
    expect(mergeRow(afterDelete, [staleRestore]).apply).toEqual({});
  });

  it('a newer explicit restore brings the row back', () => {
    const afterDelete = mergeRow({}, [del(10)]).stamps;
    const restore = { field: 'deleted_at', value: null, stamp: human(15, 'laptop') };
    expect(mergeRow(afterDelete, [restore]).apply).toEqual({ deleted_at: null });
  });

  it('a machine write can never resurrect a row the athlete deleted', () => {
    const afterDelete = mergeRow({}, [del(10)]).stamps;
    const reimport = { field: 'deleted_at', value: null, stamp: machine(1_000_000) };
    expect(mergeRow(afterDelete, [reimport]).apply).toEqual({});
  });
});
