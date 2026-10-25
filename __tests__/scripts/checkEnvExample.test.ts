import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// MZY-396: Docker Compose's env_file parser hands `KEY=   # note` to the
// container as the literal value "# note" (loadEnv strips it for tsx scripts,
// Compose does not). scripts/check-env-example.sh is the CI guard.

const script = join(__dirname, '../../scripts/check-env-example.sh');

function run(file: string) {
  return spawnSync('sh', [script, file], { encoding: 'utf8' });
}

describe('check-env-example.sh', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'env-example-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fails on an inline comment after an empty value, naming the line', () => {
    const f = join(dir, 'bad');
    writeFileSync(f, 'A=1\nTELEGRAM_BOT_TOKEN=     # secret\n');
    const r = run(f);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('2:TELEGRAM_BOT_TOKEN=');
    expect(r.stderr).toContain('inline comment after an empty value');
  });

  it('passes on comments above the key, commented-out keys and valued inline comments', () => {
    const f = join(dir, 'good');
    writeFileSync(f, '# secret\nTOKEN=\n# OPT=   # fine, commented out\nPORT=3000   # valued\n');
    expect(run(f).status).toBe(0);
  });

  it('passes on the repo .env.example', () => {
    expect(run(join(__dirname, '../../.env.example')).status).toBe(0);
  });
});
