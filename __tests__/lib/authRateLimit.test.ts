import { LoginRateLimiter, clientKey } from '@/lib/auth/rateLimit';

// Sliding-window brute-force limiter for the login gate — mirrors the sibling
// Hephaistos project's webapp/auth/rate_limit.py test coverage.

describe('LoginRateLimiter', () => {
  it('allows attempts under the threshold', () => {
    let now = 0;
    const limiter = new LoginRateLimiter(
      { maxAttempts: 5, windowSeconds: 300, lockoutSeconds: 900 },
      () => now,
    );
    for (let i = 0; i < 4; i++) limiter.recordFailure('1.2.3.4');
    expect(limiter.isAllowed('1.2.3.4')).toBe(true);
  });

  it('locks out after maxAttempts failures within the window', () => {
    let now = 0;
    const limiter = new LoginRateLimiter(
      { maxAttempts: 3, windowSeconds: 300, lockoutSeconds: 900 },
      () => now,
    );
    for (let i = 0; i < 3; i++) limiter.recordFailure('1.2.3.4');
    expect(limiter.isAllowed('1.2.3.4')).toBe(false);
    expect(limiter.retryAfterSeconds('1.2.3.4')).toBeGreaterThan(0);
  });

  it('releases the lockout after lockoutSeconds elapse', () => {
    let now = 0;
    const limiter = new LoginRateLimiter(
      { maxAttempts: 3, windowSeconds: 300, lockoutSeconds: 900 },
      () => now,
    );
    for (let i = 0; i < 3; i++) limiter.recordFailure('1.2.3.4');
    expect(limiter.isAllowed('1.2.3.4')).toBe(false);
    now += 901 * 1000;
    expect(limiter.isAllowed('1.2.3.4')).toBe(true);
  });

  it('a failure outside the sliding window does not count toward the threshold', () => {
    let now = 0;
    const limiter = new LoginRateLimiter(
      { maxAttempts: 3, windowSeconds: 300, lockoutSeconds: 900 },
      () => now,
    );
    limiter.recordFailure('1.2.3.4');
    now += 301 * 1000; // outside the 300s window
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isAllowed('1.2.3.4')).toBe(true); // only 2 in-window failures
  });

  it('a success clears the failure count for that key', () => {
    let now = 0;
    const limiter = new LoginRateLimiter(
      { maxAttempts: 3, windowSeconds: 300, lockoutSeconds: 900 },
      () => now,
    );
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    limiter.recordSuccess('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isAllowed('1.2.3.4')).toBe(true); // reset by the success
  });

  it('keys are independent of each other', () => {
    let now = 0;
    const limiter = new LoginRateLimiter(
      { maxAttempts: 2, windowSeconds: 300, lockoutSeconds: 900 },
      () => now,
    );
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isAllowed('1.2.3.4')).toBe(false);
    expect(limiter.isAllowed('5.6.7.8')).toBe(true);
  });
});

describe('clientKey', () => {
  it('returns the given ip', () => {
    expect(clientKey('1.2.3.4')).toBe('1.2.3.4');
  });

  it('falls back to "unknown" for a missing ip', () => {
    expect(clientKey(null)).toBe('unknown');
    expect(clientKey(undefined)).toBe('unknown');
    expect(clientKey('')).toBe('unknown');
  });
});
