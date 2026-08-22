import type {
  ITool,
  RiskLevel,
  Role,
  IApprovalRepository,
  IAuditRepository,
  IPermissionChecker,
  ApprovalStatus,
  ToolPermission,
  ToolApprovalCheck,
  ToolExecutionAudit,
} from "@jarvis/core";
import { APPROVAL_TTL_MS, computeParamsHash } from "@jarvis/core";

export interface ToolApprovalConfig {
  approvalTtlMs?: number;
  highRiskTools?: string[];
  autoApproveReadOnly?: boolean;
}

// PHASE 10.7: the authoritative TTL lives in core; this service no longer
// defines its own divergent default.
const DEFAULT_APPROVAL_TTL_MS = APPROVAL_TTL_MS;

const RISK_REQUIRES_APPROVAL: Record<RiskLevel, boolean> = {
  READ_ONLY: false,
  LOW_IMPACT: false,
  EXTERNAL_SIDE_EFFECT: true,
  HIGH_IMPACT: true,
  FINANCIAL: true,
};

export class ToolApprovalService {
  private approvalTtlMs: number;
  private highRiskTools: string[];
  private autoApproveReadOnly: boolean;

  constructor(
    private approvalRepo: IApprovalRepository,
    private auditRepo: IAuditRepository,
    private permissionChecker: IPermissionChecker,
    config: ToolApprovalConfig = {}
  ) {
    this.approvalTtlMs = config.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.highRiskTools = config.highRiskTools ?? [];
    this.autoApproveReadOnly = config.autoApproveReadOnly ?? true;
  }

  async checkPreExecution(
    tool: ITool,
    params: Record<string, unknown>,
    request: {
      userId: string;
      role: Role;
      executionId?: string;
      stepIndex?: number;
      traceId: string;
      conversationId?: string;
    }
  ): Promise<ToolApprovalCheck> {
    if (!tool.enabled) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Tool "${tool.id}" is disabled`,
      };
    }

    const hasPerms = tool.requiredPermissions.every((perm: ToolPermission) =>
      this.permissionChecker.hasPermission(request.role, "tools", perm)
    );
    if (!hasPerms) {
      await this.recordAudit({
        ...this.buildAuditBase(tool, params, request),
        status: "denied",
        durationMs: 0,
        error: { code: "AUTHORIZATION_FAILED", message: "Missing required permissions" },
      });
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Missing permissions: ${tool.requiredPermissions.join(", ")}`,
      };
    }

    if (!tool.validate(params)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Invalid parameters for tool "${tool.id}"`,
      };
    }

    const needsApproval = this.needsApproval(tool);

    if (!needsApproval) {
      return { allowed: true, requiresApproval: false };
    }

    const existing = await this.approvalRepo.findExistingForTool(
      tool.id,
      request.userId
    );

    if (existing && existing.status === ("approved" as ApprovalStatus)) {
      const expiresAt = new Date(existing.expiresAt).getTime();
      // An approval authorizes ONLY the exact tool, user, and parameters a
      // human approved. Missing hash (legacy approval) or mismatched hash
      // (changed params) invalidates reuse — a fresh approval is required.
      // Fail closed.
      const paramsBound =
        existing.toolId === tool.id &&
        existing.userId === request.userId &&
        !!existing.paramsHash &&
        existing.paramsHash === computeParamsHash(params);
      if (expiresAt > Date.now() && paramsBound) {
        return {
          allowed: true,
          requiresApproval: false,
          approvalId: existing.id,
          reason: "Using cached approval",
        };
      }
    }

    const approval = await this.requestApproval(tool, params, request);
    await this.recordAudit({
      ...this.buildAuditBase(tool, params, request),
      status: "approval_pending",
      durationMs: 0,
      approvalId: approval.id,
    });

    return {
      allowed: false,
      requiresApproval: true,
      approvalId: approval.id,
      reason: `Tool "${tool.id}" requires approval (risk: ${tool.risk})`,
    };
  }

  async validateApproval(
    approvalId: string
  ): Promise<{ valid: boolean; reason?: string }> {
    const approval = await this.approvalRepo.findById(approvalId);
    if (!approval) {
      return { valid: false, reason: "Approval not found" };
    }

    if (approval.status !== ("approved" as ApprovalStatus)) {
      return {
        valid: false,
        reason: `Approval status is "${approval.status}"`,
      };
    }

    const expiresAt = new Date(approval.expiresAt).getTime();
    if (expiresAt <= Date.now()) {
      return { valid: false, reason: "Approval has expired" };
    }

    return { valid: true };
  }

  async recordExecution(
    audit: ToolExecutionAudit
  ): Promise<void> {
    await this.auditRepo.create({
      userId: audit.userId,
      agentId: audit.executionId,
      toolId: audit.tool,
      action: audit.action,
      parameters: audit.arguments,
      result: audit.status === "success" ? "success"
        : audit.status === "denied" || audit.status === "approval_rejected" ? "rejected"
        : audit.status === "approval_pending" ? "pending"
        : "failure",
      traceId: audit.traceId,
      metadata: {
        stepIndex: audit.stepIndex,
        durationMs: audit.durationMs,
        approvalId: audit.approvalId,
        error: audit.error,
      },
    });
  }

  private needsApproval(tool: ITool): boolean {
    if (this.highRiskTools.includes(tool.id)) {
      return true;
    }

    if (tool.risk === "READ_ONLY") {
      return !this.autoApproveReadOnly;
    }

    return RISK_REQUIRES_APPROVAL[tool.risk] ?? true;
  }

  private async requestApproval(
    tool: ITool,
    params: Record<string, unknown>,
    request: {
      userId: string;
      executionId?: string;
      stepIndex?: number;
      traceId: string;
      conversationId?: string;
    }
  ): Promise<{ id: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.approvalTtlMs);

    const approval = await this.approvalRepo.create({
      userId: request.userId,
      agentId: request.executionId,
      toolId: tool.id,
      action: tool.description,
      params,
      // bind approval to exact params; canonical form is never logged
      paramsHash: computeParamsHash(params),
      expiresAt: expiresAt.toISOString(),
    });

    return { id: approval.id, expiresAt };
  }

  private buildAuditBase(
    tool: ITool,
    params: Record<string, unknown>,
    request: {
      userId: string;
      executionId?: string;
      stepIndex?: number;
      traceId: string;
      conversationId?: string;
    }
  ): Omit<ToolExecutionAudit, "status" | "durationMs" | "error" | "approvalId"> {
    return {
      executionId: request.executionId ?? crypto.randomUUID(),
      stepIndex: request.stepIndex ?? 0,
      userId: request.userId,
      tool: tool.id,
      action: tool.description,
      risk: tool.risk,
      arguments: params,
      traceId: request.traceId,
      conversationId: request.conversationId,
      timestamp: new Date(),
    };
  }

  private async recordAudit(
    audit: Partial<ToolExecutionAudit> & {
      status: ToolExecutionAudit["status"];
      durationMs: number;
    }
  ): Promise<void> {
    await this.auditRepo.create({
      userId: audit.userId ?? "",
      agentId: audit.executionId,
      toolId: audit.tool,
      action: audit.action ?? "",
      parameters: audit.arguments,
      result: audit.status === "success" ? "success"
        : audit.status === "denied" || audit.status === "approval_rejected" ? "rejected"
        : audit.status === "approval_pending" ? "pending"
        : "failure",
      traceId: audit.traceId ?? "",
      metadata: {
        stepIndex: audit.stepIndex,
        durationMs: audit.durationMs,
        approvalId: audit.approvalId,
        error: audit.error,
      },
    });
  }
}
