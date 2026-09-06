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

/** Audit-action namespace a limiter counts within. */
export const RATE_LIMIT_NAMESPACES = {
  approval: "approval",
  voice: "voice",
} as const;

export type RateLimitNamespace =
  (typeof RATE_LIMIT_NAMESPACES)[keyof typeof RATE_LIMIT_NAMESPACES];

export class DbBackedRateLimiter {
  private readonly namespace: string;

  /**
   * @param namespace Audit-action prefix this limiter counts, e.g. counting
   *   `approval.approve` or `voice.transcribe`. Defaults to `approval` so the
   *   Phase 10.7 call sites keep their exact behaviour.
   *
   * Sprint 8.0 parameterised what was a hardcoded `approval.` prefix. The
   * alternative — a second limiter class for voice — would have duplicated the
   * window logic and, worse, split the definition of "too many requests"
   * across two implementations that could drift.
   */
  constructor(
    private readonly auditLogger: AuditLogger,
    namespace: RateLimitNamespace | string = RATE_LIMIT_NAMESPACES.approval
  ) {
    this.namespace = namespace;
  }

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

    // Matching on the full `namespace.bucket` prefix keeps buckets from
    // bleeding into each other: counting bare `transcribe` would also match an
    // unrelated action that happened to start with it.
    const prefix = `${this.namespace}.${bucket}`;
    const currentCount = entries.filter((e) =>
      String(e.action).startsWith(prefix)
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

/**
 * Sprint 8.0 — voice policy, counted under the `voice.` namespace.
 *
 * Sized for a person pressing a microphone button, not for a loop. Speech is
 * the more expensive of the two per call, so transcription is the tighter
 * bucket; synthesis is looser because a single reply can legitimately be
 * replayed, but still bounded, since `/voice/speak` takes caller-supplied text
 * and would otherwise be usable as an unmetered text-to-speech service.
 */
export const VOICE_RATE_LIMITS = {
  transcribe: { limit: 30, windowMs: 60_000 },
  speak: { limit: 60, windowMs: 60_000 },
} as const;
