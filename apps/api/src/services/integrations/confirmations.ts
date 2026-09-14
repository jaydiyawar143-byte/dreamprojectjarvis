// ---------------------------------------------------------------------------
// Confirmation tokens for external write actions.
//
// The rule this enforces: JARVIS may never perform an outward-facing write
// because a sentence sounded like a request. Every such action is described
// first, confirmed second, executed third — and the confirmation is bound to
// the exact thing that was described.
//
// BINDING IS THE WHOLE POINT. A token carries a hash of (user, integration,
// action, parameters). A confirmation obtained for "pause campaign A" therefore
// cannot be replayed to pause campaign B: the parameters hash differs, so the
// lookup fails and the second call is refused. Without that binding a
// confirmation would be a general-purpose write permit valid for sixty
// seconds, which is a worse hole than not confirming at all.
//
// SINGLE USE. Consuming deletes. A retry after a successful confirm has to ask
// again, because "the network dropped, did it go through?" and "run it twice"
// are indistinguishable here, and the safe reading of an ambiguous retry on an
// irreversible action is to stop.
//
// IN MEMORY ON PURPOSE. A pending confirmation is a few seconds of
// conversational state. Persisting it would outlive the conversation that
// created it and create a durable, replayable write permit — the opposite of
// what it is for. Losing them on restart is correct: after a restart nobody has
// confirmed anything.
// ---------------------------------------------------------------------------

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  computeParamsHash,
  type IntegrationConfirmation,
  type IntegrationId,
} from "@jarvis/core";

/** Short enough that a stale confirmation cannot be used later. */
const CONFIRMATION_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING = 2000;

interface PendingConfirmation {
  userId: string;
  integration: IntegrationId;
  actionId: string;
  /** SHA-256 over the canonical parameters. Binds the token to this call. */
  paramsHash: string;
  summary: string;
  irreversible: boolean;
  expiresAt: number;
}

const pending = new Map<string, PendingConfirmation>();

// Parameters are bound with the same canonical hash the approval system uses:
// `computeParamsHash` in @jarvis/core sorts keys at EVERY depth. The UI and the
// model may serialise one request in different key orders and still match,
// while a change to any nested value — a budget inside a campaign object —
// produces a different hash and the token is refused.

function sweep(now: number): void {
  for (const [token, record] of pending) {
    if (record.expiresAt <= now) pending.delete(token);
  }
}

export interface IssueInput {
  userId: string;
  integration: IntegrationId;
  actionId: string;
  params: Record<string, unknown>;
  summary: string;
  irreversible: boolean;
}

/** Creates a pending confirmation and returns what the caller should show. */
export function issueConfirmation(input: IssueInput): IntegrationConfirmation {
  const now = Date.now();
  sweep(now);

  // Bounded, so a caller that requests confirmations in a loop and never
  // answers them cannot grow this map without limit.
  if (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) pending.delete(oldest);
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + CONFIRMATION_TTL_MS;

  pending.set(token, {
    userId: input.userId,
    integration: input.integration,
    actionId: input.actionId,
    paramsHash: computeParamsHash(input.params),
    summary: input.summary,
    irreversible: input.irreversible,
    expiresAt,
  });

  return {
    token,
    summary: input.summary,
    integration: input.integration,
    actionId: input.actionId,
    expiresAt: new Date(expiresAt).toISOString(),
    irreversible: input.irreversible,
  };
}

export type ConsumeOutcome =
  | { ok: true; summary: string }
  | { ok: false; reason: "unknown" | "expired" | "mismatch" };

/**
 * Verifies and consumes a confirmation token.
 *
 * Deletes on EVERY outcome once the token is found, including a mismatch: a
 * token presented against the wrong parameters has been misused, and leaving it
 * alive would let a caller keep guessing which parameters it was minted for.
 */
export function consumeConfirmation(input: {
  token: string;
  userId: string;
  integration: IntegrationId;
  actionId: string;
  params: Record<string, unknown>;
}): ConsumeOutcome {
  const now = Date.now();
  sweep(now);

  const record = pending.get(input.token);
  if (!record) return { ok: false, reason: "unknown" };

  pending.delete(input.token);

  if (record.expiresAt <= now) return { ok: false, reason: "expired" };

  // Constant-time on the hash so a caller cannot learn the bound parameters by
  // measuring how long a rejection takes.
  const expected = Buffer.from(record.paramsHash, "hex");
  const actual = Buffer.from(computeParamsHash(input.params), "hex");
  const hashMatches =
    expected.length === actual.length && timingSafeEqual(expected, actual);

  if (
    record.userId !== input.userId ||
    record.integration !== input.integration ||
    record.actionId !== input.actionId ||
    !hashMatches
  ) {
    return { ok: false, reason: "mismatch" };
  }

  return { ok: true, summary: record.summary };
}

/** Test seam. */
export function __resetConfirmations(): void {
  pending.clear();
}

/** Visible only to tests and diagnostics; never serialised to a client. */
export function __pendingCount(): number {
  return pending.size;
}
