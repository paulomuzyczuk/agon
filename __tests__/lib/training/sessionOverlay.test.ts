import {
  resolveSession,
  adjustmentNote,
  type PlanFields,
} from '@/lib/training/sessionOverlay';

// Precedence rules for plan + adjustment. Pure — no DB, no calendar.

function plan(over: Partial<PlanFields> = {}): PlanFields {
  return {
    date: '2026-08-22',
    block: 3,
    week: 22,
    description: 'Long run',
    targetDistanceKm: 19.4,
    targetHrCap: 158,
    targetSessionType: 'long',
    ...over,
  };
}

describe('resolveSession', () => {
  it('returns the plan untouched when there is no adjustment', () => {
    const resolved = resolveSession(plan(), null);
    expect(resolved).toMatchObject({ ...plan(), adjusted: false });
    expect(resolved.originalDate).toBeNull();
  });

  it('treats an all-null adjustment as no adjustment', () => {
    const resolved = resolveSession(plan(), {
      date: null,
      description: null,
      targetDistanceKm: null,
    });
    expect(resolved.adjusted).toBe(false);
    expect(resolved.targetDistanceKm).toBe(19.4);
  });

  it('overrides only the fields the adjustment sets', () => {
    const resolved = resolveSession(plan(), { targetDistanceKm: 25 });
    expect(resolved.targetDistanceKm).toBe(25);
    expect(resolved.description).toBe('Long run'); // untouched
    expect(resolved.targetHrCap).toBe(158);
    expect(resolved.adjusted).toBe(true);
  });

  it('recomputes block/week when the date moves, and records the original', () => {
    // 2026-08-22 is week 22; moving a week out must not keep the old stamp, or
    // per-week rollups silently attribute the load to the wrong week.
    const resolved = resolveSession(plan(), { date: '2026-08-29' });
    expect(resolved.date).toBe('2026-08-29');
    expect(resolved.originalDate).toBe('2026-08-22');
    expect(resolved.week).toBe(23);
    expect(resolved.adjusted).toBe(true);
  });

  it('keeps a Block 4 stamp for a move within the same week (MZY-259)', () => {
    // computeBlockWeek only models Blocks 1–3 and clamps past them; a Block 4
    // session dragged a day later must not be relabelled "Block 3".
    const resolved = resolveSession(
      plan({ date: '2026-09-30', block: 4, week: 28 }),
      { date: '2026-10-01' },
    );
    expect(resolved).toMatchObject({ block: 4, week: 28 });
  });

  it('keeps a Block 4 stamp for a move past the modelled blocks, recomputing the week', () => {
    const resolved = resolveSession(
      plan({ date: '2026-10-04', block: 4, week: 28 }),
      { date: '2026-10-06' },
    );
    expect(resolved).toMatchObject({ block: 4, week: 29 });
  });

  it('leaves block/week alone when the date is unchanged', () => {
    const resolved = resolveSession(plan({ block: null, week: null }), {
      description: 'Long run (hot)',
    });
    expect(resolved.block).toBeNull();
    expect(resolved.week).toBeNull();
  });

  it('keeps a zero distance rather than falling back to the plan', () => {
    // 0 is a real value (a cancelled-but-kept session); only null means "unset".
    const resolved = resolveSession(plan(), { targetDistanceKm: 0 });
    expect(resolved.targetDistanceKm).toBe(0);
    expect(resolved.adjusted).toBe(true);
  });

  it('counts a note alone as an adjustment', () => {
    const resolved = resolveSession(plan(), {
      note: 'calf tight, keep it easy',
    });
    expect(resolved.adjusted).toBe(true);
    expect(resolved.note).toBe('calf tight, keep it easy');
  });

  it('does not flag an adjustment that restates the plan', () => {
    const resolved = resolveSession(plan(), { targetDistanceKm: 19.4 });
    expect(resolved.adjusted).toBe(false);
  });
});

describe('adjustmentNote', () => {
  it('is null for an unadjusted session', () => {
    expect(adjustmentNote(resolveSession(plan(), null))).toBeNull();
  });

  it('states where a moved session came from', () => {
    const note = adjustmentNote(resolveSession(plan(), { date: '2026-08-23' }));
    expect(note).toBe('📝 moved from 2026-08-22');
  });

  it('combines the move with the athlete note', () => {
    const note = adjustmentNote(
      resolveSession(plan(), { date: '2026-08-23', note: 'rest day swap' }),
    );
    expect(note).toBe('📝 moved from 2026-08-22 — rest day swap');
  });

  it('falls back to a generic line when only content changed', () => {
    const note = adjustmentNote(
      resolveSession(plan(), { targetDistanceKm: 25 }),
    );
    expect(note).toBe('📝 Adjusted from the plan');
  });
});
