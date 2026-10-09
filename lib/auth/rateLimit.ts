// Brute-force defense for the shared-secret login (the one credential guarding
// the whole app). A sliding-window counter of FAILED attempts per client key;
// once the window fills, the key is locked out for a fixed cooldown during
// which even the correct secret is refused. Success clears the key. Mirrors
// the sibling Hephaistos project's webapp/auth/rate_limit.py.
//
// In-memory + module-scoped: correct for a single long-running `next start`
// process (self-hosted, not stateless serverless — see CLAUDE.md's
// self-hosting network-exposure decision), same single-owner-tool assumption
// as the rest of this auth layer. The clock is injectable for deterministic
// tests.

export interface RateLimitConfig {
  maxAttempts: number;
  windowSeconds: number;
  lockoutSeconds: number;
}

/** Defaults: 5 failures / 5 min -> 15-minute lockout. */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxAttempts: 5,
  windowSeconds: 300,
  lockoutSeconds: 900,
};

export class LoginRateLimiter {
  private readonly config: RateLimitConfig;
  private readonly clock: () => number;
  private readonly failures = new Map<string, number[]>();
  private readonly lockedUntil = new Map<string, number>();

  constructor(config: RateLimitConfig = DEFAULT_RATE_LIMIT, clock: () => number = Date.now) {
    this.config = config;
    this.clock = clock;
  }

  /** False while `key` is in its lockout cooldown. */
  isAllowed(key: string): boolean {
    const locked = this.lockedUntil.get(key);
    return locked === undefined || this.clock() >= locked;
  }

  /** Record a failed attempt; trip a lockout once the window is full. */
  recordFailure(key: string): void {
    const now = this.clock();
    const windowStart = now - this.config.windowSeconds * 1000;
    const recent = (this.failures.get(key) ?? []).filter((t) => t >= windowStart);
    recent.push(now);
    if (recent.length >= this.config.maxAttempts) {
      this.lockedUntil.set(key, now + this.config.lockoutSeconds * 1000);
      this.failures.delete(key); // the lockout now governs
    } else {
      this.failures.set(key, recent);
    }
  }

  /** Clear all failure state for `key` (a valid login resets the counter). */
  recordSuccess(key: string): void {
    this.failures.delete(key);
    this.lockedUntil.delete(key);
  }

  /** Seconds until `key` may try again (0 if not locked). For a Retry-After header. */
  retryAfterSeconds(key: string): number {
    const locked = this.lockedUntil.get(key);
    if (locked === undefined) return 0;
    const now = this.clock();
    if (now >= locked) return 0;
    return Math.ceil((locked - now) / 1000);
  }
}

// One shared limiter for the process lifetime — see the module comment above
// for why module-scoped state is correct here.
export const loginRateLimiter = new LoginRateLimiter();

/** Rate-limit key from the request's best-effort client IP (a missing/proxied
 * IP buckets under one shared key — acceptable for a single-owner tool). */
export function clientKey(ip: string | null | undefined): string {
  return ip || 'unknown';
}
