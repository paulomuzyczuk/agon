import {
  expandMonthlyTimeTrials,
  timeTrialFields,
} from '@/lib/training/timeTrials';
import { getRunDetail } from '@/lib/training/sessionDetails';
import { estimateRunMinutes } from '@/services/googleCalendar/eventSlots';

// Monthly time trials — pure expansion, no DB.

/** Monday of the ISO week a date falls in. */
function weekOf(dateISO: string): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

const weekday = (dateISO: string) =>
  new Date(`${dateISO}T00:00:00Z`).getUTCDay(); // 0=Sun … 6=Sat

describe('expandMonthlyTimeTrials', () => {
  it('lays down 5 / 15 / 10 / 21.1 km in the first four weeks of each month', () => {
    // January 2027 starts on a Friday → first Monday is the 4th.
    const jan = expandMonthlyTimeTrials('2027-01', 1);
    expect(jan.map((s) => [s.dateISO, s.targetDistanceKm])).toEqual([
      ['2027-01-06', 5],
      ['2027-01-16', 15],
      ['2027-01-20', 10],
      ['2027-01-30', 21.1],
    ]);
  });

  it('puts 5 and 10 km on Wednesday and 15 and 21.1 km on Saturday', () => {
    for (const s of expandMonthlyTimeTrials('2027-01', 12)) {
      const short = s.targetDistanceKm === 5 || s.targetDistanceKm === 10;
      expect(weekday(s.dateISO)).toBe(short ? 3 : 6);
    }
  });

  it('never puts two trials in one calendar week, even across month ends', () => {
    // June 2027's first Monday is the 7th, so its week-4 Saturday is 3 July.
    const all = expandMonthlyTimeTrials('2027-01', 12);
    const weeks = all.map((s) => weekOf(s.dateISO));
    expect(new Set(weeks).size).toBe(weeks.length);
    expect(all.map((s) => s.dateISO)).toContain('2027-07-03');
  });

  it('builds all-out run sessions keyed like program runs', () => {
    const [first] = expandMonthlyTimeTrials('2027-02', 1);
    expect(first).toEqual({
      planKey: '2027-02-03:run',
      dateISO: '2027-02-03',
      block: null,
      week: null,
      sessionKind: 'run',
      description: 'Time trial',
      targetSessionType: 'time_trial',
      targetDistanceKm: 5,
      targetHrCap: null,
    });
  });

  it('rolls December into the next year', () => {
    const dates = expandMonthlyTimeTrials('2027-12', 2).map((s) => s.dateISO);
    expect(dates.slice(4).every((d) => d.startsWith('2028-01'))).toBe(true);
  });

  it('rejects a malformed month or count, naming what it got', () => {
    expect(() => expandMonthlyTimeTrials('2027-13', 1)).toThrow(
      /got '2027-13'/,
    );
    expect(() => expandMonthlyTimeTrials('Jan 2027', 1)).toThrow(/YYYY-MM/);
    expect(() => expandMonthlyTimeTrials('2027-01', 0)).toThrow(/got 0/);
    expect(() => expandMonthlyTimeTrials('2027-01', 1.5)).toThrow(
      /positive integer/,
    );
  });
});

describe('time trial session details', () => {
  it('shares one field set across both placement paths', () => {
    expect(timeTrialFields(15)).toEqual({
      description: 'Time trial',
      targetSessionType: 'time_trial',
      targetDistanceKm: 15,
      targetHrCap: null,
    });
  });

  it('carries a warm-up / main / cool-down structure', () => {
    expect(getRunDetail('time_trial')).toHaveLength(3);
  });

  it('sizes the event for the trial plus warm-up and cool-down', () => {
    expect(estimateRunMinutes(5, 'time_trial')).toBe(50); // 25 + 25
    expect(estimateRunMinutes(21.1, 'time_trial')).toBe(131); // 106 + 25
  });
});
