// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — single-use nonces.
//
// A signed request is only replay-safe if the signature can be spent once. The
// timestamp window alone is not enough: inside the window a captured request
// is still valid, so the nonce is what makes it single-use.
//
// The port exists because a single browser-service process is the only
// deployment Stage 19.2 proves. A multi-instance deployment needs a shared
// store — PostgreSQL, a cache with an atomic add — and that decision is
// deliberately NOT made here (ADR-19-002's unresolved item, §9 U2). The
// process store is correct for one process and is named for it, so nobody can
// mistake it for a shared one.
//
// A store that cannot answer must refuse the request, never accept it. That is
// why `use` may reject: the caller treats a rejection as UNAUTHENTICATED.
// ---------------------------------------------------------------------------

import { BROWSER_PROTOCOL_NONCE_TTL_MS } from "./limits.js";

export interface NonceStorePort {
  /**
   * Remember a nonce until `expiresAt`, or report that it was already used.
   *
   * Returns `true` for the first use of a nonce, `false` when it has been
   * seen. The check and the write are one operation: two requests that arrive
   * together must not both see "first use".
   */
  use(nonce: string, expiresAt: number): boolean | Promise<boolean>;
}

/**
 * One process's memory.
 *
 * The check-and-insert is synchronous, so two requests handled by the same
 * event loop cannot both win. That is a real guarantee for one process and no
 * guarantee at all across processes — which is exactly why a second instance
 * is a blocker, not a configuration change.
 */
export class ProcessNonceStore implements NonceStorePort {
  private readonly seen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  use(nonce: string, expiresAt: number): boolean {
    const current = this.now();
    this.prune(current);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, expiresAt);
    return true;
  }

  /** Drops nonces that can no longer be inside their window. */
  prune(now: number = this.now()): void {
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(nonce);
    }
  }

  /** Test seam: how many nonces are remembered right now. */
  get size(): number {
    return this.seen.size;
  }
}

/**
 * The expiry a nonce gets when a request carries `timestamp`.
 *
 * It covers the whole window in which the signature could still verify: the
 * nonce must outlive every second of its own request's validity, or a replay
 * that arrives just before the window closes would find the nonce pruned.
 */
export function nonceExpiryFor(timestampMs: number, clockSkewMs: number, now: number): number {
  return Math.max(timestampMs, now) + Math.max(BROWSER_PROTOCOL_NONCE_TTL_MS, clockSkewMs);
}
