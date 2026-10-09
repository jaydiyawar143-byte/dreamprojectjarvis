// ---------------------------------------------------------------------------
// Phase 14 — what the memory tools may do, joined at the composition root.
//
// The tools know one port. This file builds it from the services that already
// exist; it adds no store, no second manager and no rule of its own:
//
//   list          MemoryManagementService, scoped to what the CONVERSATION the
//                 tool was called in may see — personal memories plus its own
//                 project's. The project is read from the conversation row by
//                 (conversation id, user id); a model has no way to name one.
//   forget        MemoryManagementService, unchanged.
//   forgetAll     MemoryManagementService, unchanged.
//   correct       finds the saved USER message the confirmed action points at
//                 — only in a conversation this user owns — takes the new
//                 value from that message, and hands it to the memory writer.
//                 The writer decides (L1–L4) and writes; this only carries.
//   purgeExpired  MemoryManagementService: this user's long-expired memories.
//
// The writer is looked up at call time because it is built after the tools
// are registered, and is absent altogether when no embedding provider is
// configured: correction then fails closed.
// ---------------------------------------------------------------------------

import type { ConversationMessage, MemoryCorrectionOutcome, MemoryCorrectionStatus, MemoryCorrectionTarget } from "@jarvis/core";
import { detectMemoryCommand } from "@jarvis/agents";
import type { MemoryToolPort } from "@jarvis/tools";
import type { MemoryCorrectionRequest, MemoryManagementService } from "@jarvis/memory";

export interface MemoryToolPortDeps {
  memoryManagement: Pick<MemoryManagementService, "list" | "forget" | "forgetAll" | "purgeExpired" | "recordCorrection">;
  conversations: {
    findByIdAndUserId(conversationId: string, userId: string): Promise<{ projectId?: string | null } | null>;
    findMessageOwned(userId: string, messageId: string): Promise<(ConversationMessage & { conversationId: string }) | null>;
  };
  /** The memory writer, or null when learning is not configured. */
  corrector: () => { correct(request: MemoryCorrectionRequest): Promise<MemoryCorrectionOutcome> } | null;
}

/**
 * The new value a saved message carries: the statement of a chat correction
 * ("that's wrong. I prefer light mode" → "I prefer light mode"), or — for a
 * message the memory screen saved — the message itself.
 */
export function correctionStatementOf(content: string): string {
  const command = detectMemoryCommand(content);
  return command.kind === "CORRECT" && command.statement ? command.statement : content.trim();
}

export function createMemoryToolPort(deps: MemoryToolPortDeps): MemoryToolPort {
  async function correct(userId: string, target: MemoryCorrectionTarget): Promise<MemoryCorrectionStatus> {
    const corrector = deps.corrector();
    if (!corrector) return "FAILED";

    const message = await deps.conversations.findMessageOwned(userId, target.sourceMessageId);
    if (!message || message.role !== "user") return "SOURCE_NOT_FOUND";

    const traceId = message.metadata?.traceId;
    const outcome = await corrector.correct({
      userId,
      memoryId: target.id,
      version: target.version,
      statement: correctionStatementOf(message.content),
      userMessage: message.content,
      conversationId: message.conversationId,
      messageId: message.id,
      // The trace of the request that saved the message — its own provenance.
      ...(typeof traceId === "string" ? { traceId } : {}),
    });
    return outcome.status;
  }

  return {
    async list(userId, options) {
      const { conversationId, ...rest } = options;
      const conversation = conversationId ? await deps.conversations.findByIdAndUserId(conversationId, userId) : null;
      return deps.memoryManagement.list(userId, {
        ...rest,
        scope: { kind: "VISIBLE_IN", projectId: conversation?.projectId ?? null },
      });
    },
    forget: (userId, targets) => deps.memoryManagement.forget(userId, targets),
    forgetAll: (userId, scope) => deps.memoryManagement.forgetAll(userId, scope),
    async correct(userId, target) {
      let status: MemoryCorrectionStatus;
      try {
        status = await correct(userId, target);
      } catch {
        status = "FAILED";
      }
      await deps.memoryManagement.recordCorrection(userId, target.id, status);
      return { status };
    },
    purgeExpired: (userId) => deps.memoryManagement.purgeExpired(userId),
  };
}
