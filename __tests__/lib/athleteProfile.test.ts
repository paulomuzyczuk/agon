import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getAthleteProfile,
  ftpOn,
  _resetAthleteProfileCacheForTests,
} from '@/lib/athleteProfile';

// Pure config-loading logic (same shape as scripts/seed-nutrition-goals.ts's
// path-resolution + explicit-error behaviour) — no DB, just fs + zod.

const VALID_PROFILE = {
  timeZone: 'Europe/Berlin',
  trainingStartDate: '2026-03-23',
  programWeeksPerBlock: 8,
  programBlockCount: 3,
  hrMax: 190,
  hrRest: 60,
  sweatRateBaselineLPerH: 0.8,
  sweatSodiumMgPerL: 950,
  liftSweatRateLPerH: 0.4,
  weightKgFallback: 75,
  startingWeightKg: 80,
  startingBodyFatPct: 20,
};

describe('getAthleteProfile', () => {
  let dir: string;
  const originalEnv = process.env.AGON_ATHLETE_PROFILE_PATH;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agon-athlete-profile-'));
    _resetAthleteProfileCacheForTests();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.AGON_ATHLETE_PROFILE_PATH;
    else process.env.AGON_ATHLETE_PROFILE_PATH = originalEnv;
    _resetAthleteProfileCacheForTests();
  });

  it('loads and validates a well-formed profile from AGON_ATHLETE_PROFILE_PATH', () => {
    const path = join(dir, 'profile.json');
    writeFileSync(path, JSON.stringify(VALID_PROFILE));
    process.env.AGON_ATHLETE_PROFILE_PATH = path;

    expect(getAthleteProfile()).toEqual(VALID_PROFILE);
  });

  it('memoizes after the first successful load (a later file edit is not re-read)', () => {
    const path = join(dir, 'profile.json');
    writeFileSync(path, JSON.stringify(VALID_PROFILE));
    process.env.AGON_ATHLETE_PROFILE_PATH = path;

    const first = getAthleteProfile();
    writeFileSync(path, JSON.stringify({ ...VALID_PROFILE, hrMax: 200 }));
    expect(getAthleteProfile()).toBe(first);
    expect(getAthleteProfile().hrMax).toBe(190);
  });

  it('throws a clear, actionable error when the file is missing', () => {
    process.env.AGON_ATHLETE_PROFILE_PATH = join(dir, 'does-not-exist.json');
    expect(() => getAthleteProfile()).toThrow(/athlete-profile\.example\.json/);
  });

  it('throws when the file fails schema validation (e.g. a missing field)', () => {
    const path = join(dir, 'profile.json');
    const { hrMax: _omit, ...incomplete } = VALID_PROFILE;
    writeFileSync(path, JSON.stringify(incomplete));
    process.env.AGON_ATHLETE_PROFILE_PATH = path;

    expect(() => getAthleteProfile()).toThrow();
  });

  it('throws on a malformed trainingStartDate', () => {
    const path = join(dir, 'profile.json');
    writeFileSync(path, JSON.stringify({ ...VALID_PROFILE, trainingStartDate: 'not-a-date' }));
    process.env.AGON_ATHLETE_PROFILE_PATH = path;

    expect(() => getAthleteProfile()).toThrow();
  });
});

describe('ftpHistory (MZY-269)', () => {
  let dir: string;
  const originalEnv = process.env.AGON_ATHLETE_PROFILE_PATH;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agon-athlete-profile-ftp-'));
    _resetAthleteProfileCacheForTests();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.AGON_ATHLETE_PROFILE_PATH;
    else process.env.AGON_ATHLETE_PROFILE_PATH = originalEnv;
    _resetAthleteProfileCacheForTests();
  });

  function load(extra: Record<string, unknown>) {
    const path = join(dir, 'profile.json');
    writeFileSync(path, JSON.stringify({ ...VALID_PROFILE, ...extra }));
    process.env.AGON_ATHLETE_PROFILE_PATH = path;
    return getAthleteProfile();
  }

  it('is optional — a profile without it still loads', () => {
    expect(load({}).ftpHistory).toBeUndefined();
  });

  it('accepts a well-formed history', () => {
    const ftpHistory = [{ watts: 240, date: '2026-05-01' }];
    expect(load({ ftpHistory }).ftpHistory).toEqual(ftpHistory);
  });

  it('rejects an implausible watts value or a malformed date', () => {
    expect(() => load({ ftpHistory: [{ watts: 5000, date: '2026-05-01' }] })).toThrow();
    _resetAthleteProfileCacheForTests();
    expect(() => load({ ftpHistory: [{ watts: 240, date: '1 May' }] })).toThrow();
  });

  it('vo2maxMeasured is optional and bounded to a plausible range (MZY-303)', () => {
    expect(load({}).vo2maxMeasured).toBeUndefined();
    _resetAthleteProfileCacheForTests();
    expect(load({ vo2maxMeasured: 50 }).vo2maxMeasured).toBe(50);
    _resetAthleteProfileCacheForTests();
    expect(() => load({ vo2maxMeasured: 5 })).toThrow();
    _resetAthleteProfileCacheForTests();
    expect(() => load({ vo2maxMeasured: '50' })).toThrow();
  });
});

describe('ftpOn', () => {
  const history = [
    { watts: 250, date: '2026-06-01' },
    { watts: 220, date: '2026-01-05' },
    { watts: 235, date: '2026-03-02' },
  ];

  it('returns null with no history or before the first entry', () => {
    expect(ftpOn('2026-04-01', undefined)).toBeNull();
    expect(ftpOn('2026-04-01', [])).toBeNull();
    expect(ftpOn('2026-01-04', history)).toBeNull();
  });

  it('applies an entry from its own date onward', () => {
    expect(ftpOn('2026-01-05', history)).toBe(220);
    expect(ftpOn('2026-03-01', history)).toBe(220);
    expect(ftpOn('2026-03-02', history)).toBe(235);
  });

  it('does not trust the file order', () => {
    expect(ftpOn('2026-05-31', history)).toBe(235);
    expect(ftpOn('2026-09-01', history)).toBe(250);
  });
});
