import { isPublicPath } from '@/lib/auth/cookie';

describe('isPublicPath', () => {
  it('serves the service worker without a session (MZY-207), but not app pages or data', () => {
    expect(isPublicPath('/sw.js')).toBe(true);
    expect(isPublicPath('/nutrition')).toBe(false);
    expect(isPublicPath('/api/sync/pull')).toBe(false);
  });
});
