import {
  isWildcardBind,
  assertSafeBind,
  loadWebBindConfig,
  BindSafetyError,
  type WebBindConfig,
} from '@/lib/webBind';

// Bind-safety guard (self-hosting decision) — mirrors the sibling Hephaistos
// project's webapp/config.py test coverage.

describe('isWildcardBind', () => {
  it('flags 0.0.0.0, ::, and empty string as wildcards', () => {
    expect(isWildcardBind('0.0.0.0')).toBe(true);
    expect(isWildcardBind('::')).toBe(true);
    expect(isWildcardBind('')).toBe(true);
    expect(isWildcardBind('  ')).toBe(true);
  });

  it('does not flag a specific address', () => {
    expect(isWildcardBind('127.0.0.1')).toBe(false);
    expect(isWildcardBind('100.64.1.2')).toBe(false); // a Tailscale IP
    expect(isWildcardBind('localhost')).toBe(false);
  });
});

describe('assertSafeBind', () => {
  const base: WebBindConfig = {
    bindHost: '127.0.0.1',
    bindPort: 3000,
    sessionTtlSeconds: 43200,
    allowPublic: false,
  };

  it('allows a specific-address bind without allowPublic', () => {
    expect(() => assertSafeBind(base)).not.toThrow();
  });

  it('refuses a wildcard bind without allowPublic', () => {
    expect(() => assertSafeBind({ ...base, bindHost: '0.0.0.0' })).toThrow(
      BindSafetyError,
    );
  });

  it('allows a wildcard bind when allowPublic is explicitly set', () => {
    expect(() =>
      assertSafeBind({ ...base, bindHost: '0.0.0.0', allowPublic: true }),
    ).not.toThrow();
  });
});

describe('loadWebBindConfig', () => {
  it('defaults to localhost:3000 with public exposure off', () => {
    expect(loadWebBindConfig({})).toEqual({
      bindHost: '127.0.0.1',
      bindPort: 3000,
      sessionTtlSeconds: 604800, // 7 days (MZY-28)
      allowPublic: false,
    });
  });

  it('reads a Tailscale IP and custom port from env', () => {
    const config = loadWebBindConfig({
      AGON_WEB_BIND_HOST: '100.64.1.2',
      AGON_WEB_BIND_PORT: '8080',
    });
    expect(config.bindHost).toBe('100.64.1.2');
    expect(config.bindPort).toBe(8080);
  });

  it('parses AGON_WEB_ALLOW_PUBLIC truthy values case-insensitively', () => {
    expect(
      loadWebBindConfig({ AGON_WEB_ALLOW_PUBLIC: 'true' }).allowPublic,
    ).toBe(true);
    expect(
      loadWebBindConfig({ AGON_WEB_ALLOW_PUBLIC: 'YES' }).allowPublic,
    ).toBe(true);
    expect(
      loadWebBindConfig({ AGON_WEB_ALLOW_PUBLIC: 'false' }).allowPublic,
    ).toBe(false);
    expect(loadWebBindConfig({}).allowPublic).toBe(false);
  });

  it('throws on a non-integer port', () => {
    expect(() => loadWebBindConfig({ AGON_WEB_BIND_PORT: 'abc' })).toThrow();
  });
});
