import path from 'path';
import { formatWeeklyPlan } from '@/services/mcp/curated';
import {
  resolveSessionRow,
  type SessionRow,
} from '@/services/plannedSessionView';

// weekly_plan reads the RESOLVED plan (MZY-265): sessions sit where the athlete
// moved them, carry their hand-edited fields, and say how they deviate. Pure —
// the formatter takes rows, no DB.

// The example profile: 3 blocks × 8 weeks from 2026-01-05, so week 25+ lies past
// the modelled blocks (where computeBlockWeek only clamps).
process.env.AGON_ATHLETE_PROFILE_PATH = path.join(
  __dirname,
  '../../config/athlete-profile.example.json',
);

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'id-1',
    date: '2026-07-04',
    block: 4,
    week: 26,
    session_kind: 'run',
    status: 'synced',
    description: 'Long easy run',
    target_distance_km: '19.00',
    target_hr_cap: 150,
    target_session_type: 'long',
    gcal_event_id: null,
    gcal_fueling_event_id: null,
    gcal_pushed: null,
    outcome: null,
    start_time: '14:00',
    start_time_priority: null,
    start_time_reason: null,
    adj_date: null,
    adj_description: null,
    adj_target_distance_km: null,
    adj_target_hr_cap: null,
    adj_target_session_type: null,
    adj_note: null,
    adj_detail: null,
    ...over,
  };
}

const RANGE = { start: '2026-06-29', end: '2026-07-05' };

describe('resolveSessionRow', () => {
  it('passes an unadjusted row through with no note', () => {
    const { resolved, note } = resolveSessionRow(row());
    expect(resolved.targetDistanceKm).toBe(19);
    expect(resolved.adjusted).toBe(false);
    expect(note).toBeNull();
  });

  it('lays the adjustment over the plan', () => {
    const { resolved, note } = resolveSessionRow(
      row({ adj_target_distance_km: '21.20', adj_note: 'distance edited' }),
    );
    expect(resolved.targetDistanceKm).toBe(21.2);
    expect(note).toBe('📝 distance edited');
  });
});

describe('formatWeeklyPlan', () => {
  it('shows the resolved distance, title, date and the adj note', () => {
    const out = formatWeeklyPlan(
      [
        row({ adj_target_distance_km: '21.20', adj_note: 'distance edited' }),
        row({
          id: 'id-2',
          date: '2026-07-02',
          session_kind: 'lift',
          description: 'Lift B — full body',
          target_distance_km: null,
          target_hr_cap: null,
          target_session_type: null,
          start_time: '20:15',
          adj_date: '2026-07-05',
        }),
        row({
          id: 'id-3',
          date: '2026-07-05',
          session_kind: 'bike',
          description: 'Easy bike ride',
          target_distance_km: null,
          adj_description: 'Bike ride — Home → RSO',
          adj_target_distance_km: '16.30',
          adj_detail: 'Easy Zone 2 spin\nOne-way: <b>home</b> → RSO',
        }),
      ],
      RANGE,
      { block: 3, week: 26 },
    );
    expect(out).toContain(
      '| Sat 2026-07-04 | 14:00 | run | Long easy run | 21.2 |',
    );
    expect(out).toContain('📝 distance edited');
    // Lift B moved Thu → Sun keeps its time and says where it came from.
    expect(out).toContain(
      '| Sun 2026-07-05 | 20:15 | lift | Lift B — full body |',
    );
    expect(out).toContain('📝 moved from 2026-07-02');
    expect(out).not.toContain('Thu 2026-07-02');
    expect(out).toContain('Bike ride — Home → RSO | 16.3 |');
    expect(out).toContain(
      '- Sun 2026-07-05 bike: Easy Zone 2 spin · One-way: home → RSO',
    );
  });

  it('labels a week past the modelled blocks with the sessions’ own block (MZY-259)', () => {
    const out = formatWeeklyPlan([row()], RANGE, { block: 3, week: 26 });
    expect(out).toMatch(/^\*\*Block 4 · Week 26\*\*/);
  });

  it('keeps the computed block inside the modelled blocks', () => {
    const out = formatWeeklyPlan([row({ block: 2, week: 10 })], RANGE, {
      block: 2,
      week: 10,
    });
    expect(out).toMatch(/^\*\*Block 2 · Week 10\*\*/);
  });

  it('shows a skipped session as skipped', () => {
    const out = formatWeeklyPlan([row({ status: 'skipped' })], RANGE, {
      block: 3,
      week: 26,
    });
    expect(out).toContain('| skipped |');
  });
});
