const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

type Attempt = { failures: number; resetAt: number };

export class LoginRateLimiter {
  private readonly attempts = new Map<string, Attempt>();

  check(key: string, now = Date.now()): { allowed: boolean; retryAfter: number } {
    const attempt = this.attempts.get(key);
    if (!attempt || attempt.resetAt <= now) {
      if (attempt) this.attempts.delete(key);
      return { allowed: true, retryAfter: 0 };
    }
    if (attempt.failures < MAX_FAILURES) return { allowed: true, retryAfter: 0 };
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((attempt.resetAt - now) / 1000)) };
  }

  fail(key: string, now = Date.now()): void {
    const current = this.attempts.get(key);
    if (!current || current.resetAt <= now) {
      this.attempts.set(key, { failures: 1, resetAt: now + WINDOW_MS });
      return;
    }
    current.failures += 1;
  }

  success(key: string): void {
    this.attempts.delete(key);
  }
}

export const loginRateLimiter = new LoginRateLimiter();
