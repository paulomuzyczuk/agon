import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { docker, dockerArgs } from '../../scripts/backupShared';

// MZY-401: after Docker Desktop is installed a scheduler's clean environment
// resolves to the empty `desktop-linux` engine, so the backup's `docker exec`
// failed with "no such container". AGON_DOCKER_HOST pins the engine.

describe('dockerArgs', () => {
  it('leaves the arguments alone when no host is set', () => {
    expect(dockerArgs(['exec', 'c'], {})).toEqual(['exec', 'c']);
    expect(dockerArgs(['exec', 'c'], { AGON_DOCKER_HOST: '' })).toEqual([
      'exec',
      'c',
    ]);
  });

  it('puts --host before the subcommand', () => {
    expect(
      dockerArgs(['exec', 'c'], {
        AGON_DOCKER_HOST: 'unix:///var/run/docker.sock',
      }),
    ).toEqual(['--host', 'unix:///var/run/docker.sock', 'exec', 'c']);
  });

  it.each([
    '/var/run/docker.sock',
    'desktop-linux',
    'http://x',
    'unix://',
    'unix:// a',
  ])('rejects %j, naming the variable and the value', (bad) => {
    expect(() => dockerArgs(['ps'], { AGON_DOCKER_HOST: bad })).toThrow(
      new RegExp(`AGON_DOCKER_HOST must look like .*got "${bad}"`),
    );
  });
});

describe('docker()', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agon-fake-docker-'));
    // A shim that records its argv, standing in for the real CLI (no network, no engine).
    writeFileSync(
      join(dir, 'docker'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\n`,
    );
    chmodSync(join(dir, 'docker'), 0o755);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const argv = () =>
    readFileSync(join(dir, 'argv'), 'utf8').split('\n').filter(Boolean);
  const env = (extra: Record<string, string> = {}) => ({
    PATH: `${dir}:/usr/bin:/bin`,
    ...extra,
  });

  it('passes --host to the CLI when AGON_DOCKER_HOST is set', async () => {
    await docker(['exec', 'agon-db-1', 'pg_restore', '-l'], {
      env: env({ AGON_DOCKER_HOST: 'unix:///var/run/docker.sock' }),
    });
    expect(argv()).toEqual([
      '--host',
      'unix:///var/run/docker.sock',
      'exec',
      'agon-db-1',
      'pg_restore',
      '-l',
    ]);
  });

  it('passes the arguments unchanged when it is not set', async () => {
    await docker(['exec', 'agon-db-1', 'psql'], { env: env() });
    expect(argv()).toEqual(['exec', 'agon-db-1', 'psql']);
  });

  it('rejects a malformed host before spawning anything', async () => {
    await expect(
      docker(['ps'], { env: env({ AGON_DOCKER_HOST: 'desktop-linux' }) }),
    ).rejects.toThrow(/AGON_DOCKER_HOST must look like/);
  });
});
