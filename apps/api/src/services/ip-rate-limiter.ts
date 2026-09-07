// ---------------------------------------------------------------------------
// Sprint 9.7 — rate limiting for requests that have no user yet.
//
// `DbBackedRateLimiter` counts audit rows keyed on `userId`, which works for
// every authenticated route and cannot work for the ones that matter most here:
// login, register, and the three unauthenticated webhooks. Those are precisely
// the endpoints an attacker reaches first, and until now none of them was
// bounded at all — `/auth/login` had no lockout, no backoff and no throttle.
//
// KNOWN LIMITATION, stated rather than hidden: this counter lives in process
// memory. With N instances behind a load balancer the effective limit is N
// times the configured one, and a restart forgets everything. That is still
// enormously better than no limit, and the honest alternative — a shared store
// — is a new dependency this deployment does not have. When Redis arrives, this
// is the one file to replace.
//
// The window is a fixed bucket rather than a sliding log: one integer per key
// instead of a list of timestamps, because this runs on the hot path of an
// unauthenticated endpoint and must not itself become the memory pressure.
// ---------------------------------------------------------------------------

export interface IpRateLimitDecision {
  allowed: boolean;
  currentCount: number;
  limit: number;
  /** Seconds until the current window resets, for a Retry-After header. */
  retryAfterSeconds: number;
}

export interface IpRateLimitRule {
  limit: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Ceiling on distinct keys held at once.
 *
 * Without it, a spray of forged addresses would grow the map without limit —
 * turning a rate limiter into the memory-exhaustion vector it exists to stop.
 */
const MAX_TRACKED_KEYS = 20_000;

export class IpRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Records one attempt and says whether it is allowed.
   *
   * Counts the attempt whether or not it succeeds. A limiter that only counted
   * failures would let an attacker reset their budget with one valid request.
   */
  check(key: string, rule: IpRateLimitRule): IpRateLimitDecision {
    const now = this.now();
    this.evictExpired(now);

    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      if (this.buckets.size >= MAX_TRACKED_KEYS) {
        // Full and nothing expired: refuse rather than grow. Failing closed
        // under pressure is the safe direction for an auth endpoint.
        return {
          allowed: false,
          currentCount: rule.limit,
          limit: rule.limit,
          retryAfterSeconds: Math.ceil(rule.windowMs / 1000),
        };
      }
      this.buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
      return {
        allowed: true,
        currentCount: 1,
        limit: rule.limit,
        retryAfterSeconds: Math.ceil(rule.windowMs / 1000),
      };
    }

    existing.count += 1;
    return {
      allowed: existing.count <= rule.limit,
      currentCount: existing.count,
      limit: rule.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  /** Test seam. */
  reset(): void {
    this.buckets.clear();
  }

  get trackedKeys(): number {
    return this.buckets.size;
  }

  private evictExpired(now: number): void {
    // Bounded sweep: a full scan on every request would make the limiter cost
    // grow with the number of clients.
    let examined = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
      if (++examined >= 50) break;
    }
  }
}

/**
 * Limits for endpoints that have no authenticated user.
 *
 * Sized for a person, not a script: a human mistypes a password a handful of
 * times, never sixty times a minute.
 */
export const IP_RATE_LIMITS = {
  login: { limit: 10, windowMs: 60_000 },
  register: { limit: 5, windowMs: 60_000 },
  refresh: { limit: 30, windowMs: 60_000 },
  webhook: { limit: 120, windowMs: 60_000 },
} as const satisfies Record<string, IpRateLimitRule>;

/**
 * Best-effort client address.
 *
 * `req.ip` is only trustworthy when Express has been told about the proxy in
 * front of it — see TRUST_PROXY. Behind an untrusted proxy every request looks
 * like it comes from the proxy, which makes the limit global rather than
 * per-client. That is a degradation, not a bypass, so it is accepted here and
 * documented rather than papered over by trusting X-Forwarded-For blindly.
 */
export function clientKey(req: {
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}
