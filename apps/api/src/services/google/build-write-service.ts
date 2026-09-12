// ---------------------------------------------------------------------------
// Composition root for GoogleWriteService.
//
// Separated from `container.ts` so the two adapters below are visible in a
// short file, because both of them encode a subtlety that would be invisible
// buried in eight hundred lines of wiring.
//
// ADAPTER 1 — THE APPROVAL STORE. A direct pass-through to
// `PrismaApprovalRepository`. No parallel store, no second notion of what
// "approved" means; `consumeForExecution` remains the single atomic gate.
//
// ADAPTER 2 — THE EXECUTION JOURNAL, AND WHY `created` MEANS WHAT IT DOES.
//
// The real `begin()` is idempotent through a unique constraint on
// (userId, toolId, idempotencyKey): on a second call it RETURNS THE EXISTING
// ROW rather than reporting a conflict. So "did we create it?" is not a flag
// the repository gives us — it has to be derived from the row's status:
//
//   PENDING / FAILED   -> claimable. A first attempt, or one that definitely
//                         did not apply. Proceeding is safe.
//   EXECUTING          -> another attempt holds the lease. Refuse.
//   COMPLETED          -> already applied. Refuse; never repeat.
//   UNKNOWN            -> a previous attempt's outcome is indeterminate.
//                         REFUSE, and never automatically retry: this is the
//                         state that exists so a duplicate email is impossible.
//
// And note what this adapter does NOT do: it never calls
// `claimForExecution()`. `consumeForExecution()` already performs that claim
// inside its own transaction, so claiming here first would leave the row
// EXECUTING and make the consume's own claim fail — turning every legitimate
// write into a denial.
// ---------------------------------------------------------------------------

import {
  EncryptionService,
  type AuditLogger,
} from "@jarvis/security";
import {
  type PrismaClient,
  PrismaApprovalRepository,
  PrismaGoogleConnectionRepository,
  PrismaIntegrationStateRepository,
  PrismaToolExecutionRepository,
} from "@jarvis/db";
import {
  createGoogleOAuthConfig,
  isGoogleOAuthConfigured,
  type GoogleConfig,
} from "@jarvis/google-ads";
import { DbBackedRateLimiter } from "../rate-limiter.js";
import {
  GoogleWriteService,
  type ApprovalStorePort,
  type ExecutionJournalPort,
} from "./write-service.js";

/** Statuses from which a fresh attempt may proceed. */
const CLAIMABLE = new Set(["PENDING", "APPROVED", "FAILED"]);

export interface BuildWriteInput {
  prisma: PrismaClient;
  auditLogger: AuditLogger;
}

/**
 * Builds the service, or null when this deployment cannot perform Google writes.
 *
 * Null rather than a throwing constructor: a missing Google client is an
 * ordinary deployment state, and the routes and tools report it as
 * NOT_CONFIGURED with the reason. Crashing the API because Google is not set up
 * would take down every unrelated feature.
 */
export function buildGoogleWriteService(
  input: BuildWriteInput
): GoogleWriteService | null {
  if (!process.env.JARVIS_ENCRYPTION_KEY) {
    console.log(
      JSON.stringify({
        level: "info",
        event: "google_write_disabled",
        reason: "JARVIS_ENCRYPTION_KEY is not set",
      })
    );
    return null;
  }

  // OAuth client only. Gmail, Drive and Calendar need no Ads developer token,
  // so gating on `isGoogleConfigured()` would refuse writes on a deployment
  // fully able to perform them.
  if (!isGoogleOAuthConfigured()) {
    console.log(
      JSON.stringify({
        level: "info",
        event: "google_write_disabled",
        reason: "no Google OAuth client configured",
      })
    );
    return null;
  }

  let config: GoogleConfig;
  try {
    config = createGoogleOAuthConfig();
  } catch (err) {
    // Misconfiguration must not take the API down.
    console.log(
      JSON.stringify({
        level: "warn",
        event: "google_write_init_skipped",
        reason: err instanceof Error ? err.message : "unknown",
      })
    );
    return null;
  }

  const encryption = EncryptionService.fromEnv();
  const approvalRepo = new PrismaApprovalRepository(input.prisma);
  const executionRepo = new PrismaToolExecutionRepository(input.prisma);
  const stateRepo = new PrismaIntegrationStateRepository(input.prisma);

  /** Pass-through. The existing durable store, unchanged. */
  const approvals: ApprovalStorePort = {
    create: async (data) => {
      const row = await approvalRepo.create({
        userId: data.userId,
        toolId: data.toolId,
        action: data.action,
        params: data.params,
        paramsHash: data.paramsHash,
        riskLevel: data.riskLevel,
        expiresAt: data.expiresAt,
        ...(data.conversationId ? { conversationId: data.conversationId } : {}),
      } as never);
      return { id: row.id };
    },
    findByIdForUser: async (id, userId) => {
      const row = await approvalRepo.findByIdForUser(id, userId);
      if (!row) return null;
      return {
        id: row.id,
        userId: row.userId,
        toolId: row.toolId,
        action: row.action,
        params: row.params,
        paramsHash: row.paramsHash ?? null,
        status: row.status,
        expiresAt: new Date(row.expiresAt),
      };
    },
    // THE GATE, untouched. One transaction, every condition.
    consumeForExecution: (consumeInput) => approvalRepo.consumeForExecution(consumeInput),
  };

  const journal: ExecutionJournalPort = {
    async begin(beginInput) {
      const record = await executionRepo.begin({
        userId: beginInput.userId,
        toolId: beginInput.toolId,
        idempotencyKey: beginInput.idempotencyKey,
        paramsHash: beginInput.paramsHash,
      });

      // `created` is derived from the row's status, not reported by begin():
      // see the header. A row that is EXECUTING, COMPLETED or UNKNOWN belongs
      // to an attempt that may already have had an effect.
      return {
        created: CLAIMABLE.has(record.status),
        executionId: record.executionId,
        status: record.status,
      };
    },
    async markStatus(executionId, status, detail) {
      if (status === "COMPLETED") {
        await executionRepo.markSucceeded(executionId);
        return;
      }
      if (status === "FAILED") {
        await executionRepo.markFailed(executionId, detail ? { message: detail } : undefined);
        return;
      }
      // UNKNOWN. The row stays a permanent record that this attempt's outcome
      // was never established, which is what stops an automatic retry.
      await executionRepo.markUnknown(executionId, detail ? { message: detail } : undefined);
    },
  };

  return new GoogleWriteService({
    connections: new PrismaGoogleConnectionRepository(input.prisma, encryption),
    config,
    audit: input.auditLogger,
    // Counted in the same audit-backed window every other limiter uses, in its
    // own namespace so a burst of writes cannot consume the read budget.
    rateLimiter: new DbBackedRateLimiter(input.auditLogger, "google_write"),
    approvals,
    journal,
    integrationState: {
      isEnabled: async (userId, integration) =>
        (await stateRepo.get(userId, integration)).enabled,
    },
  });
}
