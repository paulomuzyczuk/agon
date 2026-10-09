import { assertLocalTarget } from '@/scripts/seedGuard';

// The production guard-rail (sihha lineage): seed/dummy scripts must refuse a
// remote DATABASE_URL unless ALLOW_REMOTE_SEED=1 is set explicitly.
describe('assertLocalTarget', () => {
  it('allows loopback hosts', () => {
    for (const host of [
      '127.0.0.1',
      'localhost',
      'db',
      'host.docker.internal',
    ]) {
      expect(() =>
        assertLocalTarget('seed', {
          DATABASE_URL: `postgresql://agon:agon@${host}:5432/agon`,
        }),
      ).not.toThrow();
    }
  });

  it('refuses a remote host by default', () => {
    expect(() =>
      assertLocalTarget('seed', {
        DATABASE_URL: 'postgresql://u:p@db.hetzner.example:5432/agon',
      }),
    ).toThrow(/refuse remote targets/);
  });

  it('allows a remote host only when ALLOW_REMOTE_SEED=1', () => {
    expect(() =>
      assertLocalTarget('seed', {
        DATABASE_URL: 'postgresql://u:p@db.hetzner.example:5432/agon',
        ALLOW_REMOTE_SEED: '1',
      }),
    ).not.toThrow();
  });

  it('throws when DATABASE_URL is missing or malformed', () => {
    expect(() => assertLocalTarget('seed', {})).toThrow(
      /missing or not a valid/,
    );
    expect(() =>
      assertLocalTarget('seed', { DATABASE_URL: 'not a url' }),
    ).toThrow(/missing or not a valid/);
  });
});
