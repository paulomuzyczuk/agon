import {
  computeDueTasks,
  resolveBike,
  type MaintenanceTask,
  type LastService,
} from '@/lib/gearMaintenance';

const chainLube: MaintenanceTask = {
  taskKey: 'chain-lube',
  name: 'Chain lube',
  intervalKm: 300,
  intervalDays: null,
};

const safetyCheck: MaintenanceTask = {
  taskKey: 'safety-check',
  name: 'Safety check',
  intervalKm: null,
  intervalDays: 180,
};

const both: MaintenanceTask = {
  taskKey: 'brake-pads',
  name: 'Brake pad check',
  intervalKm: 1500,
  intervalDays: 365,
};

describe('computeDueTasks', () => {
  it('measures a never-serviced task from 0 km and flags it once over the interval', () => {
    const due = computeDueTasks([chainLube], [], 350, '2026-09-11');
    expect(due).toEqual([
      {
        taskKey: 'chain-lube',
        name: 'Chain lube',
        kmSinceService: 350,
        daysSinceService: null,
        intervalKm: 300,
        intervalDays: null,
      },
    ]);
  });

  it('does not flag a never-serviced task under the interval', () => {
    expect(computeDueTasks([chainLube], [], 299, '2026-09-11')).toEqual([]);
  });

  it('flags exactly at the threshold (>=)', () => {
    const due = computeDueTasks([chainLube], [], 300, '2026-09-11');
    expect(due).toHaveLength(1);
  });

  it('measures km since the most recent service', () => {
    const last: LastService = {
      taskKey: 'chain-lube',
      performedAt: '2026-08-01',
      kmAtService: 1000,
    };
    expect(computeDueTasks([chainLube], [last], 1250, '2026-09-11')).toEqual(
      [],
    );
    expect(computeDueTasks([chainLube], [last], 1300, '2026-09-11')).toEqual([
      expect.objectContaining({ taskKey: 'chain-lube', kmSinceService: 300 }),
    ]);
  });

  it('leaves a never-serviced days-only task unmeasured and not due', () => {
    expect(computeDueTasks([safetyCheck], [], 5000, '2026-09-11')).toEqual([]);
  });

  it('flags a days-only task once serviced long enough ago', () => {
    const last: LastService = {
      taskKey: 'safety-check',
      performedAt: '2026-01-01',
      kmAtService: 0,
    };
    const due = computeDueTasks([safetyCheck], [last], 0, '2026-09-11');
    expect(due).toEqual([
      {
        taskKey: 'safety-check',
        name: 'Safety check',
        kmSinceService: null,
        daysSinceService: 253,
        intervalKm: null,
        intervalDays: 180,
      },
    ]);
  });

  it('flags a dual-interval task when only the km side is crossed', () => {
    const last: LastService = {
      taskKey: 'brake-pads',
      performedAt: '2026-09-01', // 10 days ago — well under the 365-day interval
      kmAtService: 0,
    };
    const due = computeDueTasks([both], [last], 1600, '2026-09-11');
    expect(due).toEqual([
      expect.objectContaining({
        taskKey: 'brake-pads',
        kmSinceService: 1600,
        daysSinceService: 10,
      }),
    ]);
  });

  it('leaves an unrelated task in the same call unaffected', () => {
    const due = computeDueTasks(
      [chainLube, safetyCheck],
      [],
      100,
      '2026-09-11',
    );
    expect(due).toEqual([]);
  });
});

describe('resolveBike', () => {
  const gravel = { gearId: 'b1', name: 'Canyon Grail' };
  const road = { gearId: 'b2', name: 'Canyon Ultimate' };
  const commuter = { gearId: 'b3', name: 'Commuter' };

  it('reports none when no bike is active', () => {
    expect(resolveBike([], null)).toEqual({
      ok: false,
      reason: 'none',
      candidates: [],
    });
  });

  it('implies the single active bike when no name is given', () => {
    expect(resolveBike([gravel], null)).toEqual({ ok: true, bike: gravel });
  });

  it('is ambiguous with several bikes and no name', () => {
    const r = resolveBike([gravel, road], null);
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous' });
    if (!r.ok) expect(r.candidates).toEqual([gravel, road]);
  });

  it('matches a name case-insensitively', () => {
    expect(resolveBike([gravel, commuter], 'commuter')).toEqual({
      ok: true,
      bike: commuter,
    });
  });

  it('matches a unique substring', () => {
    expect(resolveBike([gravel, road], 'grail')).toEqual({
      ok: true,
      bike: gravel,
    });
  });

  it('is ambiguous when a substring hits several bikes', () => {
    const r = resolveBike([gravel, road, commuter], 'canyon');
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous' });
    if (!r.ok) expect(r.candidates).toEqual([gravel, road]);
  });

  it('prefers an exact match over substring hits', () => {
    const plain = { gearId: 'b4', name: 'Canyon' };
    expect(resolveBike([gravel, plain], 'Canyon')).toEqual({
      ok: true,
      bike: plain,
    });
  });

  it('checks a given name even with a single bike', () => {
    expect(resolveBike([gravel], 'trek')).toMatchObject({
      ok: false,
      reason: 'no-match',
    });
  });
});
