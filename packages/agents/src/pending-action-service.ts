import type {
  Approval,
  ApprovalStatus,
  RiskLevel,
  ITool,
  ToolExecutionResult,
} from "@jarvis/core";
import { APPROVAL_TTL_MS, computeParamsHash } from "@jarvis/core";
import type { PendingAction, PendingActionState } from "@jarvis/core";

export interface PendingActionServiceConfig {
  approvalRepo: {
    create(data: Omit<Approval, "id" | "status" | "createdAt">): Promise<Approval>;
    findById(id: string): Promise<Approval | null>;
    updateStatus(id: string, status: ApprovalStatus, resolvedAt?: string): Promise<Approval | null>;
    findPendingByConversationId(conversationId: string, userId: string): Promise<Approval | null>;
    updateParams(id: string, params: Record<string, unknown>, paramsHash: string): Promise<Approval | null>;
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

export interface ConfirmResult {
  success: boolean;
  pendingAction?: PendingAction;
  executionResult?: ToolExecutionResult;
  message: string;
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
   * Confirm a pending action. Transitions the approval to APPROVED.
   * Does NOT execute the tool — the caller is responsible for execution.
   */
  async confirmPendingAction(
    conversationId: string,
    userId: string
  ): Promise<ConfirmResult> {
    const pending = await this.getActivePendingAction(conversationId, userId);
    if (!pending) {
      return {
        success: false,
        message: "No pending action found for this conversation.",
      };
    }

    // Transition to APPROVED
    const result = await this.config.approvalRepo.updateStatus(
      pending.approvalId,
      "approved"
    );

    if (!result) {
      return {
        success: false,
        message: "Failed to approve the pending action.",
      };
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
   */
  async rejectPendingAction(
    conversationId: string,
    userId: string
  ): Promise<{ success: boolean; message: string }> {
    const pending = await this.getActivePendingAction(conversationId, userId);
    if (!pending) {
      return {
        success: false,
        message: "No pending action found for this conversation.",
      };
    }

    const result = await this.config.approvalRepo.updateStatus(
      pending.approvalId,
      "rejected"
    );

    if (!result) {
      return {
        success: false,
        message: "Failed to reject the pending action.",
      };
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
    newParams: Record<string, unknown>
  ): Promise<ModifyResult> {
    const pending = await this.getActivePendingAction(conversationId, userId);
    if (!pending) {
      throw new Error("No pending action found for this conversation.");
    }

    // Merge params: old params + new overrides
    const mergedParams = { ...pending.params, ...newParams };

    // Reject the old approval
    await this.config.approvalRepo.updateStatus(
      pending.approvalId,
      "rejected"
    );

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
    };
  }

  /**
   * Build a human-readable message for a pending action.
   */
  private buildPendingActionMessage(pending: PendingAction): string {
    const tool = this.config.toolRegistry.get(pending.toolId);
    const toolName = tool?.name ?? pending.toolId;

    const lines: string[] = [];
    lines.push(`${toolName} requires your confirmation.`);
    lines.push("");

    const p = pending.params;
    if (p.name) lines.push(`Name: ${p.name}`);
    if (p.objective) lines.push(`Objective: ${String(p.objective).replace("OUTCOME_", "")}`);
    if (p.dailyBudget) lines.push(`Budget: ₹${p.dailyBudget}/day`);
    if (p.status) lines.push(`Status: ${p.status}`);
    if (p.campaignId) lines.push(`Campaign ID: ${p.campaignId}`);

    if (pending.riskLevel === "HIGH_IMPACT" || pending.riskLevel === "FINANCIAL") {
      lines.push("");
      lines.push("⚠ This is a high-risk action. Please confirm carefully.");
    }

    lines.push("");
    lines.push("Reply 'yes' to confirm, 'no' to cancel, or provide updated parameters.");

    return lines.join("\n");
  }
}
