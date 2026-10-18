import type {
  Approval,
  ApprovalStatus,
  RiskLevel,
  ITool,
  ToolExecutionResult,
} from "@jarvis/core";
import {
  APPROVAL_TTL_MS,
  MARKETING_TOOL_IDS,
  MEMORY_CORRECT_TOOL_ID,
  computeParamsHash,
  isDestructiveMemoryTool,
  needsIndependentApproval,
} from "@jarvis/core";
import type { PendingAction, PendingActionState } from "@jarvis/core";

export interface PendingActionServiceConfig {
  approvalRepo: {
    create(data: Omit<Approval, "id" | "status" | "createdAt">): Promise<Approval>;
    findById(id: string): Promise<Approval | null>;
    updateStatus(id: string, status: ApprovalStatus, resolvedAt?: string): Promise<Approval | null>;
    findPendingByConversationId(conversationId: string, userId: string): Promise<Approval | null>;
    updateParams(id: string, params: Record<string, unknown>, paramsHash: string): Promise<Approval | null>;
    /**
     * The ONE conditional write that resolves a waiting action
     * (PrismaApprovalRepository.decideApproval): UPDATE … WHERE status is
     * PENDING and unexpired, with the affected-row count deciding the winner.
     * `fromPendingOnly` makes a reject, like an approve, apply only while the
     * approval is still PENDING.
     */
    decideApproval(
      id: string,
      userId: string,
      decision: "approve" | "reject",
      options?: { fromPendingOnly?: boolean }
    ): Promise<{ outcome: string; currentState?: string }>;
    // Phase 17 — an Organization's write (`needsIndependentApproval`) is never
    // approved by its requester: decideApproval answers
    // `self_approval_forbidden` and changes nothing.
  };
  toolRegistry: {
    get(toolId: string): ITool | undefined;
    getAll(): ITool[];
  };
  approvalTtlMs?: number;
}

export interface CreatePendingActionInput {
  conversationId: string;
  userId: string;
  toolId: string;
  action: string;
  params: Record<string, unknown>;
  riskLevel: RiskLevel;
}

export interface PendingActionResult {
  pendingAction: PendingAction;
  message: string;
}

/**
 * Why an answer to a pending action changed nothing.
 *   NOT_FOUND         nothing is waiting in this conversation
 *   MISMATCH          something is waiting, but not the action the caller named
 *   ALREADY_RESOLVED  the action was waiting when read, but another answer
 *                     resolved it first (it was confirmed, cancelled or
 *                     replaced) — this answer lost and changed nothing
 *   FAILED            the approval could not be moved
 *   NEEDS_INDEPENDENT_APPROVAL
 *                     Phase 17 — a write through a shared connection, which
 *                     its requester cannot confirm: it waits for one of the
 *                     Organization's owners or admins to approve it
 */
export type PendingActionRefusal =
  | "NOT_FOUND"
  | "MISMATCH"
  | "ALREADY_RESOLVED"
  | "FAILED"
  | "NEEDS_INDEPENDENT_APPROVAL";

/** What the requester is told while their Organization's write waits. */
export const NEEDS_INDEPENDENT_APPROVAL_MESSAGE =
  "This change needs approval from another owner or admin of your organization, so it was not run. It is waiting on their Approvals page; once they approve it, confirm here to run it.";

export interface ConfirmResult {
  success: boolean;
  pendingAction?: PendingAction;
  executionResult?: ToolExecutionResult;
  message: string;
  /** Set when `success` is false. */
  reason?: PendingActionRefusal;
}

/**
 * A modification that must not happen: the caller named an action that is not
 * the one waiting (MISMATCH), the waiting action may never be modified
 * (NOT_MODIFIABLE), or another answer resolved it first (ALREADY_RESOLVED).
 * Nothing was changed.
 */
export class PendingActionConflictError extends Error {
  constructor(
    readonly reason: "MISMATCH" | "NOT_MODIFIABLE" | "ALREADY_RESOLVED",
    message: string
  ) {
    super(message);
    this.name = "PendingActionConflictError";
  }
}

export const PENDING_ACTION_MISMATCH_MESSAGE =
  "That is no longer the action waiting for your confirmation, so nothing was changed. Answer the latest request instead.";

type Answer = "confirm" | "cancel" | "change";

/**
 * What a refused conditional write means, said truthfully. Another answer won
 * the action — it was confirmed, or cancelled or replaced — or it is gone.
 */
function refusedDecision(answer: Answer, decided: { outcome: string; currentState?: string }): { reason: PendingActionRefusal; message: string } {
  if (decided.outcome === "self_approval_forbidden") {
    return { reason: "NEEDS_INDEPENDENT_APPROVAL", message: NEEDS_INDEPENDENT_APPROVAL_MESSAGE };
  }
  const verb = answer === "cancel" ? "cancelled" : "changed";
  if (decided.outcome === "already_consumed" || (decided.outcome === "conflict" && decided.currentState === "APPROVED")) {
    return {
      reason: "ALREADY_RESOLVED",
      message: answer === "confirm" ? "That action was already confirmed." : `That action was already confirmed, so it can no longer be ${verb}.`,
    };
  }
  if (decided.outcome === "already_rejected") {
    return {
      reason: "ALREADY_RESOLVED",
      message:
        answer === "confirm"
          ? "That action was already cancelled or replaced, so nothing was confirmed or run."
          : answer === "cancel"
            ? "That action was already cancelled or replaced."
            : "That action was already cancelled or replaced, so it can no longer be changed.",
    };
  }
  if (decided.outcome === "expired" || decided.currentState === "EXPIRED") {
    return { reason: "NOT_FOUND", message: "That action has expired, so nothing was changed." };
  }
  if (decided.outcome === "conflict") {
    return { reason: "FAILED", message: "That action could not be resolved, so nothing was changed." };
  }
  return { reason: "NOT_FOUND", message: "No pending action found for this conversation." };
}

export interface ModifyResult {
  pendingAction: PendingAction;
  message: string;
}

/**
 * PHASE 11.9 — Pending Action Service
 *
 * Manages the lifecycle of pending actions (write operations awaiting
 * human confirmation). Each pending action is backed by an Approval
 * record in the database, scoped to a conversation.
 *
 * State machine:
 *   NONE → WAITING_CONFIRMATION (on create)
 *   WAITING_CONFIRMATION → APPROVED (on confirm)
 *   WAITING_CONFIRMATION → REJECTED (on reject)
 *   WAITING_CONFIRMATION → NONE (on expire, lazy)
 *   APPROVED → EXECUTING → COMPLETED | FAILED (on tool execution)
 */
export class PendingActionService {
  private approvalTtlMs: number;

  constructor(private config: PendingActionServiceConfig) {
    this.approvalTtlMs = config.approvalTtlMs ?? APPROVAL_TTL_MS;
  }

  /**
   * Create a new pending action for a write tool call.
   * Returns the pending action and a summary message for the user.
   */
  async createPendingAction(
    input: CreatePendingActionInput
  ): Promise<PendingActionResult> {
    const paramsHash = computeParamsHash(input.params);
    const expiresAt = new Date(Date.now() + this.approvalTtlMs);

    const approval = await this.config.approvalRepo.create({
      userId: input.userId,
      conversationId: input.conversationId,
      toolId: input.toolId,
      action: input.action,
      params: input.params,
      paramsHash,
      riskLevel: input.riskLevel,
      expiresAt: expiresAt.toISOString(),
    });

    const pendingAction: PendingAction = {
      id: approval.id,
      conversationId: input.conversationId,
      userId: input.userId,
      toolId: input.toolId,
      action: input.action,
      params: input.params,
      paramsHash,
      riskLevel: input.riskLevel,
      state: "WAITING_CONFIRMATION",
      approvalId: approval.id,
      expiresAt: expiresAt.toISOString(),
      createdAt: approval.createdAt,
      // Phase 17 — the store decided this when it created the approval, from
      // the owner record: an Organization's write waits for someone else.
      ...(needsIndependentApproval(approval) ? { needsIndependentApproval: true } : {}),
    };

    const message = this.buildPendingActionMessage(pendingAction);

    return { pendingAction, message };
  }

  /**
   * Get the active pending action for a conversation.
   * Returns null if no pending action exists or it has expired.
   */
  async getActivePendingAction(
    conversationId: string,
    userId: string
  ): Promise<PendingAction | null> {
    const approval = await this.config.approvalRepo.findPendingByConversationId(
      conversationId,
      userId
    );

    if (!approval) return null;

    return this.approvalToPendingAction(approval);
  }

  /**
   * The action waiting in this conversation — and, when the caller names the
   * action it is answering (`actionId`), only if it is that one.
   *
   * Audit F2 (Phase 14). A screen still showing an older request — a second
   * tab, a stale card — used to answer whatever was waiting by then, so "forget
   * X" on screen could confirm "correct Y". An answer now names its action, and
   * any other id changes nothing. A caller that names none (a typed "yes" in
   * the chat, which answers the request just shown in that conversation, or a
   * new request replacing an old one) behaves as before.
   */
  private async waitingAction(
    conversationId: string,
    userId: string,
    actionId?: string
  ): Promise<{ pending: PendingAction } | { refusal: PendingActionRefusal; message: string }> {
    const pending = await this.getActivePendingAction(conversationId, userId);
    if (!pending) return { refusal: "NOT_FOUND", message: "No pending action found for this conversation." };
    if (actionId !== undefined && pending.id !== actionId) return { refusal: "MISMATCH", message: PENDING_ACTION_MISMATCH_MESSAGE };
    return { pending };
  }

  /**
   * Resolves the waiting action with ONE conditional write.
   *
   * Reading the action as waiting proves nothing by the time it is written:
   * a Confirm and a Cancel — in this process or another API instance — can
   * both have read it. The write therefore re-checks it in the database
   * (decideApproval, `fromPendingOnly`): it changes the row only while the
   * action is still PENDING and unexpired, and the affected-row count decides
   * the winner. Exactly one answer wins; the other gets ALREADY_RESOLVED and
   * changes nothing. A cancelled action can therefore never be approved, so it
   * can never be consumed or run; an approved one is consumed at most once.
   */
  private async decide(
    pending: PendingAction,
    userId: string,
    decision: "approve" | "reject",
    answer: Answer,
    options: { fromPendingOnly: boolean } = { fromPendingOnly: true }
  ): Promise<{ ok: true } | { ok: false; reason: PendingActionRefusal; message: string }> {
    let decided: { outcome: string; currentState?: string };
    try {
      decided = await this.config.approvalRepo.decideApproval(pending.approvalId, userId, decision, options);
    } catch {
      const verb = answer === "confirm" ? "confirmed" : answer === "cancel" ? "cancelled" : "changed";
      return { ok: false, reason: "FAILED", message: `That action could not be ${verb} right now, so nothing was changed.` };
    }
    if (decided.outcome === (decision === "approve" ? "approved" : "rejected")) return { ok: true };
    return { ok: false, ...refusedDecision(answer, decided) };
  }

  /**
   * Confirm a pending action. Transitions the approval to APPROVED.
   * Does NOT execute the tool — the caller is responsible for execution.
   * With `actionId`, only that action is confirmed (see waitingAction).
   */
  async confirmPendingAction(
    conversationId: string,
    userId: string,
    actionId?: string
  ): Promise<ConfirmResult> {
    const found = await this.waitingAction(conversationId, userId, actionId);
    if ("refusal" in found) {
      return { success: false, reason: found.refusal, message: found.message };
    }
    const { pending } = found;

    // Phase 17 — an Organization's write that one of its owners or admins
    // has already approved: confirming RUNS it. Nothing is decided here — the
    // approval is someone else's — and the run is held to everything that
    // must still hold, in the transaction that consumes the approval.
    if (pending.needsIndependentApproval && pending.state === "APPROVED") {
      return {
        success: true,
        pendingAction: pending,
        message: `Approved by your organization. Running: ${pending.action}.`,
      };
    }

    // Transition to APPROVED — this action's own approval, by its id, and
    // only if it is still waiting (see decide). For an Organization's write
    // the store refuses: its requester cannot approve it.
    const decided = await this.decide(pending, userId, "approve", "confirm");
    if (!decided.ok) {
      return { success: false, reason: decided.reason, message: decided.message };
    }

    return {
      success: true,
      pendingAction: {
        ...pending,
        state: "APPROVED",
      },
      message: `Action approved. Ready to execute: ${pending.action}.`,
    };
  }

  /**
   * Reject a pending action. Transitions the approval to REJECTED.
   * With `actionId`, only that action is rejected (see waitingAction).
   */
  async rejectPendingAction(
    conversationId: string,
    userId: string,
    actionId?: string
  ): Promise<{ success: boolean; message: string; reason?: PendingActionRefusal }> {
    const found = await this.waitingAction(conversationId, userId, actionId);
    if ("refusal" in found) {
      return { success: false, reason: found.refusal, message: found.message };
    }
    const { pending } = found;

    // Only if it is still waiting: a confirmed action cannot be cancelled
    // after the fact (see decide). Phase 17 — an Organization's write that was
    // approved by someone else is still waiting for its requester to run it,
    // so the requester may still withdraw it; if a run consumed it first, the
    // store says so and nothing changes.
    const approvedForMe = pending.needsIndependentApproval === true && pending.state === "APPROVED";
    const decided = await this.decide(pending, userId, "reject", "cancel", { fromPendingOnly: !approvedForMe });
    if (!decided.ok) {
      return { success: false, reason: decided.reason, message: decided.message };
    }

    return {
      success: true,
      message: `Action cancelled: ${pending.action}.`,
    };
  }

  /**
   * Modify the parameters of a pending action.
   * Rejects the old approval and creates a new one with updated params.
   */
  async modifyPendingAction(
    conversationId: string,
    userId: string,
    newParams: Record<string, unknown>,
    actionId?: string
  ): Promise<ModifyResult> {
    const found = await this.waitingAction(conversationId, userId, actionId);
    if ("refusal" in found) {
      if (found.refusal === "MISMATCH") throw new PendingActionConflictError("MISMATCH", found.message);
      throw new Error(found.message);
    }
    const { pending } = found;

    // S7.2 L5 — a memory action names exactly the memories the user was
    // shown. It can be confirmed or cancelled, never re-targeted. Phase 14:
    // that includes a correction, whose memory and source message are ids.
    if (isDestructiveMemoryTool(pending.toolId) || pending.toolId === MEMORY_CORRECT_TOOL_ID) {
      throw new PendingActionConflictError("NOT_MODIFIABLE", "A memory action cannot be changed. Cancel it and ask again.");
    }

    // Phase 15 — a publish names the exact text and the exact place the user
    // was shown, built by the server from the saved item. Changing either here
    // would put words in front of the user that no longer match what is saved,
    // and the publish would then refuse them. The way to change a post is to
    // change the item.
    if (pending.toolId === MARKETING_TOOL_IDS.contentPublish) {
      throw new PendingActionConflictError(
        "NOT_MODIFIABLE",
        "A publish cannot be changed once it is waiting for you. Cancel it, edit the content item, and ask again."
      );
    }

    // Merge params: old params + new overrides
    const mergedParams = { ...pending.params, ...newParams };

    // Reject the old approval — only if it is still waiting. A Confirm (or
    // another change) that resolved it first wins, and no replacement is made.
    const decided = await this.decide(pending, userId, "reject", "change");
    if (!decided.ok) {
      if (decided.reason === "ALREADY_RESOLVED") throw new PendingActionConflictError("ALREADY_RESOLVED", decided.message);
      throw new Error(decided.message);
    }

    // Create a new pending action with merged params
    const result = await this.createPendingAction({
      conversationId,
      userId,
      toolId: pending.toolId,
      action: pending.action,
      params: mergedParams,
      riskLevel: pending.riskLevel as RiskLevel,
    });

    return {
      pendingAction: result.pendingAction,
      message: `Updated parameters. ${result.message}`,
    };
  }

  /**
   * Mark a pending action as executing.
   */
  async markExecuting(
    conversationId: string,
    userId: string
  ): Promise<PendingAction | null> {
    const pending = await this.getActivePendingAction(conversationId, userId);
    if (!pending) return null;

    // Approval stays APPROVED during execution
    return { ...pending, state: "EXECUTING" };
  }

  /**
   * Mark a pending action as completed.
   */
  async markCompleted(
    conversationId: string,
    userId: string
  ): Promise<void> {
    const pending = await this.getActivePendingAction(conversationId, userId);
    if (!pending) return;

    // Approval was consumed during execution — the repo handles CONSUMED state
  }

  /**
   * Mark a pending action as failed.
   */
  async markFailed(
    conversationId: string,
    userId: string
  ): Promise<void> {
    const pending = await this.getActivePendingAction(conversationId, userId);
    if (!pending) return;

    // Reset to PENDING so it can be retried
    await this.config.approvalRepo.updateStatus(
      pending.approvalId,
      "pending"
    );
  }

  /**
   * Check if a duplicate confirmation should be blocked.
   * Returns true if the pending action is already approved/consumed.
   */
  async isDuplicateConfirmation(
    conversationId: string,
    userId: string
  ): Promise<boolean> {
    const pending = await this.getActivePendingAction(conversationId, userId);
    // If no pending action, it was already executed or doesn't exist
    return pending === null;
  }

  /**
   * Convert an Approval record to a PendingAction.
   */
  private approvalToPendingAction(approval: Approval): PendingAction {
    let state: PendingActionState = "WAITING_CONFIRMATION";
    if (approval.status === "approved") state = "APPROVED";
    else if (approval.status === "consumed") state = "COMPLETED";
    else if (approval.status === "rejected") state = "REJECTED";
    else if (approval.status === "expired") state = "NONE";

    return {
      id: approval.id,
      conversationId: approval.conversationId ?? "",
      userId: approval.userId,
      toolId: approval.toolId,
      action: approval.action,
      params: approval.params,
      paramsHash: approval.paramsHash,
      riskLevel: approval.riskLevel ?? "EXTERNAL_SIDE_EFFECT",
      state,
      approvalId: approval.id,
      expiresAt: approval.expiresAt,
      createdAt: approval.createdAt,
      ...(needsIndependentApproval(approval) ? { needsIndependentApproval: true } : {}),
    };
  }

  /**
   * Build a human-readable message for a pending action.
   */
  private buildPendingActionMessage(pending: PendingAction): string {
    const tool = this.config.toolRegistry.get(pending.toolId);
    const toolName = tool?.name ?? pending.toolId;

    const lines: string[] = [];
    lines.push(
      pending.needsIndependentApproval
        ? `${toolName} needs approval from another owner or admin of your organization.`
        : `${toolName} requires your confirmation.`
    );
    lines.push("");

    const p = pending.params;
    if (p.name) lines.push(`Name: ${p.name}`);
    if (p.objective) lines.push(`Objective: ${String(p.objective).replace("OUTCOME_", "")}`);
    if (p.dailyBudget) lines.push(`Budget: ₹${p.dailyBudget}/day`);
    if (p.status) lines.push(`Status: ${p.status}`);
    if (p.campaignId) lines.push(`Campaign ID: ${p.campaignId}`);

    // Phase 15 — what will be posted and where, read from the parameters the
    // approval is bound to. This is the text that runs, not a model's
    // description of it.
    //
    // The same parameters say which of two things is being confirmed. With
    // `earlierAttempt`, an earlier attempt's outcome is not known and this
    // only looks for its post — the execution is held to that, so the person
    // is told so here rather than being asked to confirm a post.
    if (pending.toolId === MARKETING_TOOL_IDS.contentPublish) {
      const look = typeof p.earlierAttempt === "string";
      if (typeof p.targetName === "string") lines.push(`${look ? "Look on" : "Publish to"}: ${p.targetName}`);
      if (typeof p.message === "string") {
        lines.push(look ? "Text to look for:" : "Text to be posted:");
        lines.push(p.message);
      }
      if (typeof p.link === "string") lines.push(`Link: ${p.link}`);
      lines.push("");
      lines.push(
        look
          ? "An earlier attempt to publish this may already have posted it. This only looks for that post: if it is there the item is recorded as published, and if it is not, nothing is posted."
          : "This will be posted publicly and JARVIS cannot undo it."
      );
    }

    if (pending.riskLevel === "HIGH_IMPACT" || pending.riskLevel === "FINANCIAL") {
      lines.push("");
      lines.push("⚠ This is a high-risk action. Please confirm carefully.");
    }

    lines.push("");
    lines.push(
      pending.needsIndependentApproval
        ? // Phase 17 — the requester cannot confirm it; saying "reply yes"
          // would offer an answer that can only be refused.
          "It is waiting on their Approvals page. Once they approve it, reply 'yes' here to run it, or 'no' to withdraw it."
        : pending.toolId === MARKETING_TOOL_IDS.contentPublish
          ? // A publish cannot be changed while it waits (see modifyPendingAction),
            // so it is not offered.
            typeof p.earlierAttempt === "string"
            ? "Reply 'yes' to look for the post, or 'no' to cancel."
            : "Reply 'yes' to publish it, or 'no' to cancel."
          : "Reply 'yes' to confirm, 'no' to cancel, or provide updated parameters."
    );

    return lines.join("\n");
  }
}
