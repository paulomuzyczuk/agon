import { execFileSync, spawnSync } from 'child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// deploy/user/install.sh: the unit files are templates; this machine's checkout
// path and pnpm directory go into a drop-in that a re-install must never
// overwrite (agon-sync died on 2026-11-18 when a copied template reset them).

const ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'deploy/user/install.sh');
const PNPM_DIR = '/opt/test-node/v1/bin';

let dir: string;
const run = (...args: string[]) =>
  execFileSync(SCRIPT, ['--no-reload', ...args], {
    env: {
      ...process.env,
      AGON_SYSTEMD_USER_DIR: dir,
      AGON_PNPM_DIR: PNPM_DIR,
    },
    encoding: 'utf8',
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agon-units-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('deploy/user/install.sh', () => {
  it('copies the unit and timer unchanged and writes this machine into a drop-in', () => {
    run('agon-sync');
    for (const f of ['agon-sync.service', 'agon-sync.timer']) {
      expect(readFileSync(join(dir, f), 'utf8')).toBe(
        readFileSync(join(ROOT, 'deploy/user', f), 'utf8'),
      );
    }
    const conf = readFileSync(
      join(dir, 'agon-sync.service.d/local.conf'),
      'utf8',
    );
    expect(conf).toContain('[Service]');
    expect(conf).toContain(`WorkingDirectory=${ROOT}`);
    expect(conf).toContain(
      `Environment=PATH=${PNPM_DIR}:/usr/local/bin:/usr/bin:/bin`,
    );
  });

  it('re-running refreshes the unit but keeps an edited drop-in', () => {
    run('agon-sync');
    const conf = join(dir, 'agon-sync.service.d/local.conf');
    writeFileSync(conf, '[Service]\nWorkingDirectory=/my/own/place\n');
    writeFileSync(join(dir, 'agon-sync.service'), 'stale');
    const out = run('agon-sync');
    expect(readFileSync(conf, 'utf8')).toBe(
      '[Service]\nWorkingDirectory=/my/own/place\n',
    );
    expect(readFileSync(join(dir, 'agon-sync.service'), 'utf8')).toBe(
      readFileSync(join(ROOT, 'deploy/user/agon-sync.service'), 'utf8'),
    );
    expect(out).toContain('kept your');
  });

  it('installs all four units by default, each with its own drop-in', () => {
    run();
    for (const u of [
      'agon-sync',
      'agon-freshness',
      'agon-backup',
      'agon-calendar-reconcile',
    ]) {
      expect(existsSync(join(dir, `${u}.service`))).toBe(true);
      expect(existsSync(join(dir, `${u}.timer`))).toBe(true);
      expect(existsSync(join(dir, `${u}.service.d/local.conf`))).toBe(true);
    }
  });

  it('refuses an unknown unit and writes nothing', () => {
    const r = spawnSync(SCRIPT, ['--no-reload', 'agon-nope'], {
      env: { ...process.env, AGON_SYSTEMD_USER_DIR: dir },
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no such unit 'agon-nope'");
    expect(existsSync(join(dir, 'agon-sync.service'))).toBe(false);
  });

  it('the units point their install steps at the script', () => {
    for (const u of [
      'agon-sync',
      'agon-freshness',
      'agon-backup',
      'agon-calendar-reconcile',
    ]) {
      const text = readFileSync(join(ROOT, `deploy/user/${u}.service`), 'utf8');
      expect(text).toContain(`deploy/user/install.sh ${u}`);
      expect(text).not.toMatch(/^#\s+cp deploy\/user/m);
    }
  });
});
