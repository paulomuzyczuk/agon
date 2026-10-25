import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  collectEnvReads,
  documentedKeys,
  undocumentedEnvKeys,
} from '../../scripts/checkEnvKeys';

// MZY-400: scripts read AGON_BACKUP_DIR and others for months without
// .env.example listing them. The check is the guard; it needs its own tests.

const example = ['# a note', 'PORT=3000   # valued', '# OPTIONAL_KEY=1', 'EMPTY=', ''].join('\n');

describe('documentedKeys', () => {
  it('counts set, empty and commented-out keys, not prose', () => {
    expect([...documentedKeys(example)].sort()).toEqual(['EMPTY', 'OPTIONAL_KEY', 'PORT']);
  });
});

describe('collectEnvReads', () => {
  it('records the first read of each key and ignores comment lines', () => {
    const reads = collectEnvReads({
      'a.ts': '// process.env.IN_COMMENT\nconst x = process.env.REAL;\n',
      'b.ts': ' * if (!process.env.IN_DOC) {}\nconst y = process.env.REAL;\n',
    });
    expect([...reads.keys()]).toEqual(['REAL']);
    expect(reads.get('REAL')).toBe('a.ts:2');
  });

  it('does not see dynamic reads (documented limitation)', () => {
    expect(collectEnvReads({ 'a.ts': 'process.env[name]' }).size).toBe(0);
  });
});

describe('undocumentedEnvKeys', () => {
  it('names the key and where it is read', () => {
    const files = { 'scripts/x.ts': 'const d = process.env.NEW_SETTING || "d";' };
    expect(undocumentedEnvKeys(files, example)).toEqual([['NEW_SETTING', 'scripts/x.ts:1']]);
  });

  it('accepts documented keys, commented-out keys, NODE_ENV and *_AUTH_CODE', () => {
    const files = {
      'a.ts': 'process.env.PORT; process.env.OPTIONAL_KEY; process.env.NODE_ENV; process.env.STRAVA_AUTH_CODE',
    };
    expect(undocumentedEnvKeys(files, example)).toEqual([]);
  });

  it('does not let a key pass on a prefix match', () => {
    expect(undocumentedEnvKeys({ 'a.ts': 'process.env.PORT_EXTRA' }, example)).toHaveLength(1);
  });
});

describe('pnpm check:env-keys (end to end)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'envkeys-'));
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, '.env.example'), example);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = () =>
    spawnSync(join(__dirname, '../../node_modules/.bin/tsx'), [join(__dirname, '../../scripts/checkEnvKeys.ts')], {
      cwd: dir,
      encoding: 'utf8',
    });

  it('exits 1 and names the key when the code reads an unlisted one', () => {
    writeFileSync(join(dir, 'scripts/s.ts'), 'export const v = process.env.UNLISTED_ONE;\n');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('UNLISTED_ONE  (read at scripts/s.ts:1)');
  });

  it('exits 0 when every read key is listed', () => {
    writeFileSync(join(dir, 'scripts/s.ts'), 'export const v = process.env.PORT;\n');
    expect(run().status).toBe(0);
  });
});
