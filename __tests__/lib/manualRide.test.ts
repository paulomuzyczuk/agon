import {
  parseDurationToSeconds,
  parseManualRideArgs,
  manualRideExternalId,
  buildManualRideRecord,
} from '@/lib/manualRide';

const TZ = 'Europe/Berlin';
const BASE = [
  '--date=2026-10-03',
  '--start=21:09',
  '--km=6.97',
  '--duration=24:00',
];

describe('parseDurationToSeconds', () => {
  it('accepts mm:ss, h:mm:ss and plain seconds', () => {
    expect(parseDurationToSeconds('24:00')).toBe(1440);
    expect(parseDurationToSeconds('1:05:30')).toBe(3930);
    expect(parseDurationToSeconds('90:00')).toBe(5400);
    expect(parseDurationToSeconds('1465')).toBe(1465);
  });

  it('rejects malformed input', () => {
    expect(() => parseDurationToSeconds('24m')).toThrow();
    expect(() => parseDurationToSeconds('24:75')).toThrow();
    expect(() => parseDurationToSeconds('1:2:3:4')).toThrow();
  });
});

describe('parseManualRideArgs', () => {
  it('parses the required fields and defaults to a dry run', () => {
    const input = parseManualRideArgs(BASE);
    expect(input).toMatchObject({
      date: '2026-10-03',
      start: '21:09',
      km: 6.97,
      durationS: 1440,
      write: false,
      force: false,
      hrEstimated: false,
      strap: false,
    });
  });

  it('parses the optional fields and flags', () => {
    const input = parseManualRideArgs([
      ...BASE,
      '--avg-hr=127',
      '--hr-estimated',
      '--strap',
      '--rpe=4',
      '--notes=Forgot Strava.',
      '--write',
    ]);
    expect(input).toMatchObject({
      avgHr: 127,
      hrEstimated: true,
      strap: true,
      rpe: 4,
      notes: 'Forgot Strava.',
      write: true,
    });
  });

  it('rejects unknown options, a missing duration and bad values', () => {
    expect(() => parseManualRideArgs([...BASE, '--watts=200'])).toThrow(
      /unknown option/,
    );
    expect(() => parseManualRideArgs(BASE.slice(0, 3))).toThrow(/--duration/);
    expect(() =>
      parseManualRideArgs(['--date=3/10/2026', ...BASE.slice(1)]),
    ).toThrow(/YYYY-MM-DD/);
    expect(() => parseManualRideArgs([...BASE, '--km=-1'])).toThrow();
  });

  it('requires an avg HR when it is flagged as an estimate', () => {
    expect(() => parseManualRideArgs([...BASE, '--hr-estimated'])).toThrow(
      /needs --avg-hr/,
    );
  });
});

describe('buildManualRideRecord', () => {
  it('builds a manual-source ride with local→UTC start and derived speed', () => {
    const input = parseManualRideArgs([
      ...BASE,
      '--avg-hr=127',
      '--hr-estimated',
    ]);
    const ride = buildManualRideRecord(input, TZ, 'Merida Silex 400');
    expect(ride).toMatchObject({
      date: '2026-10-03',
      started_at: '2026-10-03T19:09:00.000Z', // CEST, UTC+2
      distance_km: 6.97,
      duration_s: 1440,
      avg_hr: 127,
      avg_speed_kmh: 17.43,
      bike_used: 'Merida Silex 400',
      source: 'manual',
      external_id: 'manual-2026-10-03-2109',
      start_lat: null,
    });
    expect(ride.general_notes).toMatch(/estimate, not measured/);
  });

  it('keys idempotency on the local start minute', () => {
    expect(manualRideExternalId('2026-01-05', '07:30')).toBe(
      'manual-2026-01-05-0730',
    );
  });
});

describe('manual ride power (MZY-267)', () => {
  it("stores hand-entered power with provenance 'manual'", () => {
    const input = parseManualRideArgs([
      ...BASE,
      '--avg-power=140',
      '--max-power=410',
      '--kj=205',
    ]);
    const ride = buildManualRideRecord(input, TZ, null);
    expect(ride).toMatchObject({
      avg_power_w: 140,
      max_power_w: 410,
      weighted_avg_power_w: null,
      kilojoules: 205,
      power_source: 'manual',
    });
    expect(ride.general_notes).toMatch(/Power figures were entered by hand/);
  });

  it('leaves power and its provenance null when no power flag is given', () => {
    const ride = buildManualRideRecord(parseManualRideArgs(BASE), TZ, null);
    expect(ride.power_source).toBeNull();
    expect(ride.avg_power_w).toBeNull();
    expect(ride.general_notes).not.toMatch(/Power figures/);
  });

  it('rejects max power below avg power and out-of-range watts', () => {
    expect(() =>
      parseManualRideArgs([...BASE, '--avg-power=200', '--max-power=150']),
    ).toThrow(/--max-power must be ≥ --avg-power/);
    expect(() => parseManualRideArgs([...BASE, '--avg-power=5000'])).toThrow(
      /avgPower/,
    );
  });
});
