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
  // Sprint 9.7 — the two authenticated endpoints that do real work per call,
  // and the browser tools. `voice` and `approval` keep their exact prefixes so
  // the Sprint 8 and Phase 10.7 windows are unchanged.
  chat: "chat",
  knowledge: "knowledge",
  browser: "browser",
  // Integration management. Counted separately from everything else so a burst
  // of connection tests cannot consume a user's chat budget, and so the
  // integration limits can be tuned without touching the paths above.
  integration: "integration",
  // Phase 12 — Gmail, Drive and Calendar reads. Counted apart from integration
  // management so a burst of mail reads cannot consume the budget that
  // reconnecting a broken integration needs.
  google: "google",
  // Phase 13 — approval-gated writes. Its own namespace so a burst of write
  // planning cannot exhaust the budget a read needs, and vice versa.
  google_write: "google_write",
  // Phase 15 — the marketing workspace. It meters the three things that reach
  // outside JARVIS without an approval: reads of public web pages (addresses a
  // user chose, which must not be usable as a relay or a loop), reports (each
  // reads the shared ad account several times) and publish checks (each asks
  // the provider which Pages it may post to). Counted by `AtomicRateLimiter`
  // below, which reserves a slot before the work starts.
  marketing: "marketing",
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

/**
 * Sprint 9.7 — the expensive authenticated paths.
 *
 * Every one of these spends real money or real time per call: a chat turn runs
 * the model and a tool loop, a document ingest runs extraction, chunking and N
 * embedding calls, and a browser action starts a browser. Sized so ordinary
 * interactive use never touches them — a person does not send sixty chat
 * messages a minute — while a loop does.
 */
export const CHAT_RATE_LIMITS = {
  message: { limit: 60, windowMs: 60_000 },
} as const;

export const KNOWLEDGE_RATE_LIMITS = {
  ingest: { limit: 20, windowMs: 60_000 },
} as const;

export const BROWSER_RATE_LIMITS = {
  navigate: { limit: 30, windowMs: 60_000 },
  action: { limit: 20, windowMs: 60_000 },
} as const;

// ---------------------------------------------------------------------------
// Phase 15 — the atomic limiter.
//
// `DbBackedRateLimiter.check` above answers "how many rows are in the window?"
// and leaves writing the next row to its caller. Between that answer and that
// row there is a gap, and every request that arrives inside it is given the
// same answer: sixty simultaneous page reads were all told "none yet" by a
// limit of twenty. For an endpoint whose work is short the gap is small; for
// one that makes an outbound request and audits it afterwards, it is as long
// as the request.
//
// `reserve` has no gap. It asks the audit store to count the window AND write
// the reservation row in one step that only one caller at a time can be
// inside — in PostgreSQL, so the ceiling holds across API instances as well.
// The slot is taken BEFORE the work starts, and a caller that is refused has
// written nothing and started nothing.
//
// It fails closed. If the store cannot be reached the answer is "not allowed",
// marked UNAVAILABLE so the caller can say that rather than "too many".
// ---------------------------------------------------------------------------

/** What the atomic limiter needs from the audit store. */
export interface SlotReservationPort {
  reserveSlot(input: {
    userId: string;
    action: string;
    limit: number;
    windowMs: number;
    traceId?: string;
    now?: Date;
  }): Promise<{ reserved: boolean; count: number }>;
}

export interface SlotDecision extends RateLimitDecision {
  /** Why not, when not allowed. */
  reason?: "LIMIT" | "UNAVAILABLE";
}

export class AtomicRateLimiter {
  constructor(
    private readonly store: SlotReservationPort,
    private readonly namespace: RateLimitNamespace | string
  ) {}

  /**
   * Take one slot in `bucket` for this user, or be refused.
   *
   * The row that is written — and the only row that counts — is the action
   * `namespace.bucket`, matched exactly.
   */
  async reserve(
    userId: string,
    bucket: string,
    limit: number,
    windowMs: number,
    options: { traceId?: string; now?: Date } = {}
  ): Promise<SlotDecision> {
    try {
      const taken = await this.store.reserveSlot({
        userId,
        action: `${this.namespace}.${bucket}`,
        limit,
        windowMs,
        ...(options.traceId ? { traceId: options.traceId } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
      return {
        allowed: taken.reserved,
        currentCount: taken.count,
        limit,
        windowMs,
        ...(taken.reserved ? {} : { reason: "LIMIT" as const }),
      };
    } catch {
      return { allowed: false, currentCount: limit, limit, windowMs, reason: "UNAVAILABLE" };
    }
  }
}
