// ---------------------------------------------------------------------------
// PHASE 10.7 — durable, multi-instance-safe rate limiting.
//
// Deliberately NOT an in-memory counter: instances share the AuditLog table
// in PostgreSQL, so a window count is authoritative across all processes.
// A decision endpoint consults this BEFORE performing its mutation and
// every attempt (allowed or throttled) is itself audited, which both feeds
// the next window and leaves a complete abuse trail.
//
// Trade-off documented: audit-table counting is O(window entries) per check
// with an index on (userId, createdAt); adequate for human-approval traffic,
// not designed for machine-scale request floods (those are a gateway/CDN
// concern).
// ---------------------------------------------------------------------------

import type { AuditLogger } from "@jarvis/security";

export interface RateLimitDecision {
  allowed: boolean;
  /** Entries already recorded inside the current window. */
  currentCount: number;
  limit: number;
  windowMs: number;
}

export class DbBackedRateLimiter {
  constructor(private readonly auditLogger: AuditLogger) {}

  async check(
    userId: string,
    bucket: string,
    limit: number,
    windowMs: number,
    now: Date = new Date()
  ): Promise<RateLimitDecision> {
    const since = new Date(now.getTime() - windowMs);
    const entries = await this.auditLogger.query({
      userId,
      startDate: since,
      endDate: now,
    });

    const currentCount = entries.filter((e) =>
      String(e.action).startsWith(`approval.${bucket}`)
    ).length;

    return {
      allowed: currentCount < limit,
      currentCount,
      limit,
      windowMs,
    };
  }
}

/** Default mutation policy — tuned for humans, hostile to loops. */
export const APPROVAL_RATE_LIMITS = {
  approve: { limit: 20, windowMs: 60_000 },
  reject: { limit: 20, windowMs: 60_000 },
  list: { limit: 120, windowMs: 60_000 },
} as const;
