import {
  androidVersionCode,
  parseAndroidServerUrl,
  parseAndroidSigningEnv,
} from '@/lib/androidShell';

// Capacitor shell server.url rules (MZY-274): secure origins only — the MZY-273
// spike showed plain-HTTP origins break crypto.randomUUID and the service worker.

describe('parseAndroidServerUrl', () => {
  it('accepts an https origin without cleartext', () => {
    expect(parseAndroidServerUrl('https://tower.example.ts.net')).toEqual({
      url: 'https://tower.example.ts.net',
      cleartext: false,
    });
  });

  it('accepts http only on loopback (dev via adb reverse), with cleartext', () => {
    expect(parseAndroidServerUrl('http://127.0.0.1:3000')).toEqual({
      url: 'http://127.0.0.1:3000',
      cleartext: true,
    });
    expect(parseAndroidServerUrl('http://localhost:3000').cleartext).toBe(true);
  });

  it('normalises a trailing slash and surrounding whitespace to the bare origin', () => {
    expect(parseAndroidServerUrl('  https://tower.example/  ').url).toBe(
      'https://tower.example',
    );
  });

  it('rejects plain http to a non-loopback host (e.g. a Tailscale IP)', () => {
    expect(() => parseAndroidServerUrl('http://100.64.0.10:3000')).toThrow(
      /secure context/,
    );
  });

  it('rejects a missing, malformed, or non-origin URL', () => {
    expect(() => parseAndroidServerUrl(undefined)).toThrow(/required/);
    expect(() => parseAndroidServerUrl('tower.local')).toThrow(/absolute URL/);
    expect(() => parseAndroidServerUrl('https://tower.example/record')).toThrow(
      /origin only/,
    );
    expect(() => parseAndroidServerUrl('ftp://tower.example')).toThrow(/https/);
  });
});

describe('parseAndroidSigningEnv', () => {
  const repo = '/Users/me/projects/agon';
  const valid = {
    AGON_ANDROID_KEYSTORE_PATH: '/Users/me/.agon/agon-release.jks',
    AGON_ANDROID_KEYSTORE_PASSWORD: 'store-secret',
    AGON_ANDROID_KEY_ALIAS: 'agon',
    AGON_ANDROID_KEY_PASSWORD: 'key-secret',
  };
  const exists = () => true;

  it('accepts a complete env with the keystore outside the repo', () => {
    expect(parseAndroidSigningEnv(valid, repo, exists)).toEqual({
      keystorePath: '/Users/me/.agon/agon-release.jks',
      keyAlias: 'agon',
    });
  });

  it('rejects a keystore inside the repo, a relative path, or a missing file', () => {
    const at = (p: string) => ({ ...valid, AGON_ANDROID_KEYSTORE_PATH: p });
    expect(() =>
      parseAndroidSigningEnv(at(`${repo}/android/release.jks`), repo, exists),
    ).toThrow(/outside the repo/);
    expect(() =>
      parseAndroidSigningEnv(at('release.jks'), repo, exists),
    ).toThrow(/absolute/);
    expect(() => parseAndroidSigningEnv(valid, repo, () => false)).toThrow(
      /does not exist/,
    );
  });

  it('does not mistake a sibling directory sharing the repo prefix for the repo', () => {
    const sibling = {
      ...valid,
      AGON_ANDROID_KEYSTORE_PATH: '/Users/me/projects/agon-keys/release.jks',
    };
    expect(parseAndroidSigningEnv(sibling, repo, exists).keystorePath).toBe(
      '/Users/me/projects/agon-keys/release.jks',
    );
  });

  it('names every missing secret', () => {
    expect(() =>
      parseAndroidSigningEnv(
        { AGON_ANDROID_KEYSTORE_PATH: valid.AGON_ANDROID_KEYSTORE_PATH },
        repo,
        exists,
      ),
    ).toThrow(
      /AGON_ANDROID_KEYSTORE_PASSWORD[\s\S]*AGON_ANDROID_KEY_ALIAS[\s\S]*AGON_ANDROID_KEY_PASSWORD/,
    );
  });
});

describe('androidVersionCode', () => {
  it('increases with time and is at least 1', () => {
    const a = androidVersionCode(Date.UTC(2026, 9, 7, 12, 0));
    const b = androidVersionCode(Date.UTC(2026, 9, 7, 12, 1));
    expect(b).toBe(a + 1);
    expect(androidVersionCode(0)).toBe(1);
  });
});
