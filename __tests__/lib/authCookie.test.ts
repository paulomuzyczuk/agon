import { isPublicPath } from '@/lib/auth/cookie';

describe('isPublicPath', () => {
  it('serves the service worker without a session (MZY-207), but not app pages or data', () => {
    expect(isPublicPath('/sw.js')).toBe(true);
    expect(isPublicPath('/nutrition')).toBe(false);
    expect(isPublicPath('/api/sync/pull')).toBe(false);
  });

  it('serves the PWA manifest icons without a session, so Chrome offers "Install app"', () => {
    expect(isPublicPath('/icons/icon-192.png')).toBe(true);
    expect(isPublicPath('/icons/icon-maskable-512.png')).toBe(true);
    expect(isPublicPath('/icons')).toBe(false);
    expect(isPublicPath('/iconsx/secret')).toBe(false);
  });
});
