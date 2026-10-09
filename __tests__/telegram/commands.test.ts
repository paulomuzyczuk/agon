import { parseCommand, CommandError } from '@/services/telegram/commands';

describe('parseCommand', () => {
  it('parses /weight', () => {
    expect(parseCommand('/weight 76.2')).toEqual({
      kind: 'weight',
      weightKg: 76.2,
    });
  });

  it('parses /bf', () => {
    expect(parseCommand('/bf 20.8')).toEqual({ kind: 'bf', bodyFatPct: 20.8 });
  });

  it('parses /sweat with three args', () => {
    expect(parseCommand('/sweat 76.4 75.8 0.5')).toEqual({
      kind: 'sweat',
      preKg: 76.4,
      postKg: 75.8,
      fluidL: 0.5,
    });
  });

  it('tolerates a @botname suffix and extra whitespace', () => {
    expect(parseCommand('  /week@AgonBot  ')).toEqual({ kind: 'week' });
  });

  it('parses /route with through + finish + tomorrow', () => {
    expect(
      parseCommand(
        '/route 25 through Tiergarten finish Alexanderplatz tomorrow',
      ),
    ).toEqual({
      kind: 'route',
      targetKm: 25,
      through: ['Tiergarten'],
      finishNear: 'Alexanderplatz',
      day: 'tomorrow',
      profile: 'foot-walking',
    });
  });

  it('parses /route with km suffix, multiple waypoints, and phrasing variants', () => {
    expect(
      parseCommand(
        '/route 25km through Tiergarten; Kreuzberg finishing near Alexanderplatz',
      ),
    ).toEqual({
      kind: 'route',
      targetKm: 25,
      through: ['Tiergarten', 'Kreuzberg'],
      finishNear: 'Alexanderplatz',
      day: 'today',
      profile: 'foot-walking',
    });
  });

  it('parses a bare /route distance (simple loop, today)', () => {
    expect(parseCommand('/route 12')).toEqual({
      kind: 'route',
      targetKm: 12,
      through: [],
      finishNear: null,
      day: 'today',
      profile: 'foot-walking',
    });
  });

  it('parses /route with an explicit ISO date and finish-only', () => {
    expect(parseCommand('/route 18 finish Grunewald 2026-08-10')).toEqual({
      kind: 'route',
      targetKm: 18,
      through: [],
      finishNear: 'Grunewald',
      day: '2026-08-10',
      profile: 'foot-walking',
    });
  });

  it('accepts "and" between waypoints and word order finish-before-through', () => {
    expect(
      parseCommand(
        '/route 30 finish Alexanderplatz through Grunewald and Tiergarten',
      ),
    ).toEqual({
      kind: 'route',
      targetKm: 30,
      through: ['Grunewald', 'Tiergarten'],
      finishNear: 'Alexanderplatz',
      day: 'today',
      profile: 'foot-walking',
    });
  });

  it('rejects /route with no distance', () => {
    expect(() => parseCommand('/route through Tiergarten')).toThrow(
      CommandError,
    );
  });

  it('parses /route with a "bike" keyword as a cycling loop', () => {
    expect(parseCommand('/route 40 bike finish Grunewald')).toEqual({
      kind: 'route',
      targetKm: 40,
      through: [],
      finishNear: 'Grunewald',
      day: 'today',
      profile: 'cycling-regular',
    });
  });

  it('parses /route "cycling" anywhere in the text, order-independent', () => {
    expect(
      parseCommand(
        '/route 40 through Grunewald cycling finish Alexanderplatz tomorrow',
      ),
    ).toEqual({
      kind: 'route',
      targetKm: 40,
      through: ['Grunewald'],
      finishNear: 'Alexanderplatz',
      day: 'tomorrow',
      profile: 'cycling-regular',
    });
  });

  it('picks the road cycling profile and a flat preference', () => {
    expect(parseCommand('/route 60 road bike flat finish Potsdam')).toEqual({
      kind: 'route',
      targetKm: 60,
      through: [],
      finishNear: 'Potsdam',
      day: 'today',
      profile: 'cycling-road',
      hills: 'flat',
    });
  });

  it('picks the mountain profile for gravel, and ends places at preferences', () => {
    expect(
      parseCommand('/route 45 bike through Grunewald gravel hilly tomorrow'),
    ).toEqual({
      kind: 'route',
      targetKm: 45,
      through: ['Grunewald'],
      finishNear: null,
      day: 'tomorrow',
      profile: 'cycling-mountain',
      hills: 'hilly',
    });
  });

  it('treats "mtb" as a bike keyword on its own', () => {
    const cmd = parseCommand('/route 30 mtb');
    if (cmd.kind !== 'route') throw new Error('expected route command');
    expect(cmd.profile).toBe('cycling-mountain');
  });

  it('reads "no hills" as flat, not hilly', () => {
    const cmd = parseCommand('/route 50 ride no hills');
    if (cmd.kind !== 'route') throw new Error('expected route command');
    expect(cmd.hills).toBe('flat');
  });

  it('leaves surface words alone on a running route', () => {
    expect(parseCommand('/route 10 finish Abbey Road')).toMatchObject({
      profile: 'foot-walking',
      finishNear: 'Abbey Road',
    });
  });

  it('rejects a hill preference on a running route', () => {
    expect(() => parseCommand('/route 10 flat')).toThrow(/only apply to bike/);
  });

  it('defaults to foot-walking with no mode keyword', () => {
    const cmd = parseCommand('/route 12');
    if (cmd.kind !== 'route') throw new Error('expected route command');
    expect(cmd.profile).toBe('foot-walking');
  });

  it('parses /maintained with a hyphenated task key', () => {
    expect(parseCommand('/maintained chain-lube')).toEqual({
      kind: 'maintained',
      taskKey: 'chain-lube',
      bikeName: null,
    });
  });

  it('parses /maintained with a free-text task name', () => {
    expect(parseCommand('/maintained Chain Lube')).toEqual({
      kind: 'maintained',
      taskKey: 'chain-lube',
      bikeName: null,
    });
  });

  it('rejects /maintained with no task', () => {
    expect(() => parseCommand('/maintained')).toThrow(/Usage: \/maintained/);
  });

  it('parses /maintained with an "on <bike>" name', () => {
    expect(parseCommand('/maintained chain lube on Canyon Grail')).toEqual({
      kind: 'maintained',
      taskKey: 'chain-lube',
      bikeName: 'Canyon Grail',
    });
  });

  it('rejects /maintained with an empty task or bike', () => {
    expect(() => parseCommand('/maintained on Grail')).toThrow(
      /Usage: \/maintained/,
    );
    expect(() => parseCommand('/maintained chain-lube on')).toThrow(
      /Usage: \/maintained/,
    );
  });

  it('parses /sync', () => {
    expect(parseCommand('/sync')).toEqual({ kind: 'sync' });
  });

  it('parses /undo', () => {
    expect(parseCommand('/undo')).toEqual({ kind: 'undo' });
  });

  it('rejects a non-command', () => {
    expect(() => parseCommand('hello')).toThrow(CommandError);
  });

  it('rejects an unknown command', () => {
    expect(() => parseCommand('/nope')).toThrow(/Unknown command/);
  });

  it('rejects a non-numeric weight', () => {
    expect(() => parseCommand('/weight heavy')).toThrow(/must be a number/);
  });

  it('rejects an out-of-range weight', () => {
    expect(() => parseCommand('/weight 862')).toThrow(/out of range/);
  });

  it('rejects the wrong arg count for /sweat', () => {
    expect(() => parseCommand('/sweat 76 75')).toThrow(/Usage: \/sweat/);
  });

  it('rejects a physically impossible weigh-in (post > pre + fluid)', () => {
    expect(() => parseCommand('/sweat 75 80 1')).toThrow(/exceeds/);
  });

  describe('missed-stop commands (MZY-254)', () => {
    it('parses the tap-to-send /trim_<n> and /keep_<n> forms', () => {
      expect(parseCommand('/trim_7')).toEqual({
        kind: 'stop',
        action: 'apply',
        shortId: 7,
      });
      expect(parseCommand('/keep_12@AgonBot')).toEqual({
        kind: 'stop',
        action: 'dismiss',
        shortId: 12,
      });
    });

    it('parses the typed /trim <n> form', () => {
      expect(parseCommand('/trim 3')).toEqual({
        kind: 'stop',
        action: 'apply',
        shortId: 3,
      });
    });

    it('rejects a missing or bad number', () => {
      expect(() => parseCommand('/trim')).toThrow(CommandError);
      expect(() => parseCommand('/keep x')).toThrow(/keep_<n>/);
      expect(() => parseCommand('/trim_0')).toThrow(CommandError);
      expect(() => parseCommand('/trim_3 4')).toThrow(CommandError);
    });
  });
});
