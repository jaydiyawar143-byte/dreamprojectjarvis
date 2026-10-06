// ---------------------------------------------------------------------------
// Confirmation tokens for external write actions.
//
// The rule this enforces: JARVIS may never perform an outward-facing write
// because a sentence sounded like a request. Every such action is described
// first, confirmed second, executed third — and the confirmation is bound to
// the exact thing that was described.
//
// BINDING IS THE WHOLE POINT. A confirmation carries a hash of (user,
// integration, action, parameters). One obtained for "pause campaign A"
// therefore cannot be replayed to pause campaign B: the parameters hash
// differs, and the call is refused. Without that binding a confirmation would
// be a general-purpose write permit valid for two minutes, which is a worse
// hole than not confirming at all.
//
// SINGLE USE. Presenting a token spends it, whatever the verdict — accepted,
// expired or presented for something else. A retry after a successful confirm
// has to ask again, because "the network dropped, did it go through?" and "run
// it twice" are indistinguishable here, and the safe reading of an ambiguous
// retry on an irreversible action is to stop. A token presented for the wrong
// parameters has been misused, and leaving it alive would let a caller keep
// guessing which parameters it was minted for.
//
// IN POSTGRESQL SINCE PHASE 13. This state used to be a Map in one process, on
// the reasoning that a persisted confirmation would be "a durable, replayable
// write permit". It cost two things: a restart between the question and the
// answer lost the answer, and a second API instance could not honour a
// confirmation the first one issued. The store answers the original objection
// instead of ignoring it:
//
//   - THE TOKEN IS NEVER STORED. The row holds its SHA-256. A copy of the
//     table — a backup, a dump — cannot confirm anything.
//   - NOR IS WHAT THE USER TYPED. Only the canonical hash of the parameters is
//     kept; no parameter value and no summary reaches the table.
//   - SPENDING IS ONE ATOMIC STATEMENT in the store, so of any number of
//     instances and requests presenting one token, exactly one is answered.
//   - IT STILL LIVES TWO MINUTES. Persisting it did not lengthen it.
//
// A STORE THAT CANNOT BE ASKED IS NOT AN ANSWER. `issue` and `consume` reject
// when the store fails; the command service turns that into a refusal and
// reports it to the error monitor. Nothing here falls back to process memory.
// ---------------------------------------------------------------------------

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  computeParamsHash,
  type IConfirmationRepository,
  type IntegrationConfirmation,
  type IntegrationId,
} from "@jarvis/core";
import type { OperationalLog } from "../observability/operational-log.js";

/** Short enough that a stale confirmation cannot be used later. */
export const CONFIRMATION_TTL_MS = 2 * 60 * 1000;

/**
 * How long a spent or expired row is kept before it is deleted.
 *
 * It is no longer usable in that time — it is kept so that "what happened to
 * that confirmation?" has an answer for a day. The audit log is the long-lived
 * record; this is operational state.
 */
export const CONFIRMATION_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface IssueInput {
  userId: string;
  integration: IntegrationId;
  actionId: string;
  params: Record<string, unknown>;
  summary: string;
  irreversible: boolean;
  /** For the log line only. */
  traceId?: string;
}

export interface ConsumeInput {
  token: string;
  userId: string;
  integration: IntegrationId;
  actionId: string;
  params: Record<string, unknown>;
  /** For the log line only. */
  traceId?: string;
}

export type ConsumeOutcome =
  | { ok: true }
  | { ok: false; reason: "unknown" | "expired" | "mismatch" };

/** What the command service depends on. */
export interface ConfirmationPort {
  /** Stores a pending confirmation and returns what the caller should show. */
  issue(input: IssueInput): Promise<IntegrationConfirmation>;
  /** Verifies and spends a confirmation token. */
  consume(input: ConsumeInput): Promise<ConsumeOutcome>;
}

export interface ConfirmationServiceOptions {
  now?: () => Date;
  log?: OperationalLog;
}

/** What the store is keyed by. The token itself never leaves this process. */
export function hashConfirmationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Parameters are bound with the same canonical hash the approval system uses:
// `computeParamsHash` in @jarvis/core sorts keys at EVERY depth. The UI and the
// model may serialise one request in different key orders and still match,
// while a change to any nested value — a budget inside a campaign object —
// produces a different hash and the token is refused.

export function createConfirmationService(
  store: IConfirmationRepository,
  options: ConfirmationServiceOptions = {}
): ConfirmationPort {
  const now = options.now ?? (() => new Date());
  const log = options.log?.child("confirmations");

  return {
    async issue(input) {
      const issuedAt = now();

      // Housekeeping rides on issuing, so no background loop is needed. It is
      // best effort: a failed clear-out must not cost the user their action.
      try {
        await store.deleteExpiredBefore(new Date(issuedAt.getTime() - CONFIRMATION_RETENTION_MS));
      } catch {
        log?.warn("confirmation_cleanup_failed");
      }

      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(issuedAt.getTime() + CONFIRMATION_TTL_MS);

      // Not caught: a confirmation that could not be saved must not be handed out.
      const { id } = await store.create({
        tokenHash: hashConfirmationToken(token),
        userId: input.userId,
        integration: input.integration,
        actionId: input.actionId,
        paramsHash: computeParamsHash(input.params),
        expiresAt,
      });

      log?.info("confirmation_issued", {
        confirmationId: id,
        userId: input.userId,
        integration: input.integration,
        actionId: input.actionId,
        expiresAt: expiresAt.toISOString(),
        ...(input.traceId ? { traceId: input.traceId } : {}),
      });

      return {
        token,
        summary: input.summary,
        integration: input.integration,
        actionId: input.actionId,
        expiresAt: expiresAt.toISOString(),
        irreversible: input.irreversible,
      };
    },

    async consume(input) {
      const presentedAt = now();

      // The one atomic step. Whoever is handed the record is the only caller
      // that can go on to accept it; the token is spent for everyone else.
      // Not caught: a store that cannot answer must not be read as "yes".
      const record = await store.consume(hashConfirmationToken(input.token), presentedAt);

      const refuse = (reason: "unknown" | "expired" | "mismatch"): ConsumeOutcome => {
        log?.warn("confirmation_refused", {
          reason,
          ...(record ? { confirmationId: record.id } : {}),
          userId: input.userId,
          integration: input.integration,
          actionId: input.actionId,
          ...(input.traceId ? { traceId: input.traceId } : {}),
        });
        return { ok: false, reason };
      };

      // Never issued, or already spent. The two are deliberately not told apart.
      if (!record) return refuse("unknown");

      // Judged on THIS instance's clock, against an expiry the issuing instance
      // wrote from its own. Instances are assumed to agree to within seconds,
      // against a lifetime of two minutes. Single use, above, needs no clock.
      if (record.expiresAt.getTime() <= presentedAt.getTime()) return refuse("expired");

      // Constant-time on the hash so a caller cannot learn the bound parameters
      // by measuring how long a rejection takes.
      const expected = Buffer.from(record.paramsHash, "hex");
      const actual = Buffer.from(computeParamsHash(input.params), "hex");
      const hashMatches = expected.length === actual.length && timingSafeEqual(expected, actual);

      if (
        record.userId !== input.userId ||
        record.integration !== input.integration ||
        record.actionId !== input.actionId ||
        !hashMatches
      ) {
        return refuse("mismatch");
      }

      log?.info("confirmation_consumed", {
        confirmationId: record.id,
        userId: input.userId,
        integration: input.integration,
        actionId: input.actionId,
        ...(input.traceId ? { traceId: input.traceId } : {}),
      });
      return { ok: true };
    },
  };
}
