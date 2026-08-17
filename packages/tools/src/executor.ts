import type {
  ITool,
  IToolExecutor,
  ToolExecutionRequest,
  ToolExecutionResult,
  IPermissionChecker,
  IApprovalManager,
  AuditLogger,
  ToolResult,
} from "@jarvis/core";

const DEFAULT_TIMEOUT_MS = 30000;

export class ToolExecutor implements IToolExecutor {
  private readonly defaultTimeoutMs: number;

  constructor(
    private registry: { get(toolId: string): ITool | undefined },
    private permissionChecker: IPermissionChecker,
    private approvalManager: IApprovalManager,
    private auditLogger: AuditLogger,
    config?: { defaultTimeoutMs?: number }
  ) {
    this.defaultTimeoutMs = config?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const executionId = crypto.randomUUID();
    const startedAt = new Date();

    const tool = this.registry.get(request.toolId);
    if (!tool) {
      const completedAt = new Date();
      await this.audit(request, executionId, "failure", startedAt);
      return {
        executionId,
        toolId: request.toolId,
        status: "failed",
        error: "Tool not found",
        startedAt,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      };
    }

    if (!tool.validate(request.params)) {
      const completedAt = new Date();
      await this.audit(request, executionId, "failure", startedAt);
      return {
        executionId,
        toolId: request.toolId,
        status: "failed",
        error: "Invalid input parameters",
        startedAt,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      };
    }

    for (const perm of tool.requiredPermissions) {
      if (!this.permissionChecker.hasPermission(request.role, "tools", perm)) {
        const completedAt = new Date();
        await this.audit(request, executionId, "rejected", startedAt);
        return {
          executionId,
          toolId: request.toolId,
          status: "permission_denied",
          error: `Missing permission: ${perm}`,
          startedAt,
          completedAt,
          durationMs: completedAt.getTime() - startedAt.getTime(),
        };
      }
    }

    if (tool.requiresApproval) {
      const existing =
        await this.approvalManager.findExistingForTool(
          request.toolId,
          request.userId
        );

      let hasValidApproval = false;

      if (existing) {
        if (
          existing.status === "approved" &&
          new Date(existing.expiresAt) > new Date()
        ) {
          hasValidApproval = true;
        } else if (existing.status === "rejected") {
          const completedAt = new Date();
          await this.audit(request, executionId, "rejected", startedAt);
          return {
            executionId,
            toolId: request.toolId,
            status: "approval_denied",
            approvalId: existing.id,
            error: "Approval was rejected",
            startedAt,
            completedAt,
            durationMs: completedAt.getTime() - startedAt.getTime(),
          };
        } else if (existing.status === "pending") {
          const completedAt = new Date();
          await this.audit(request, executionId, "pending", startedAt);
          return {
            executionId,
            toolId: request.toolId,
            status: "approval_pending",
            approvalId: existing.id,
            startedAt,
            completedAt,
            durationMs: completedAt.getTime() - startedAt.getTime(),
          };
        }
        // expired or approved-but-expired → fall through to request new approval
      }

      if (!hasValidApproval) {
        const approval = await this.approvalManager.requestApproval({
          userId: request.userId,
          agentId: request.agentId,
          toolId: request.toolId,
          action: "execute",
          params: request.params,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        });

        const completedAt = new Date();
        await this.audit(request, executionId, "pending", startedAt);
        return {
          executionId,
          toolId: request.toolId,
          status: "approval_pending",
          approvalId: approval.id,
          startedAt,
          completedAt,
          durationMs: completedAt.getTime() - startedAt.getTime(),
        };
      }
    }

    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    let result: ToolResult;
    try {
      result = await this.executeWithTimeout(
        () =>
          tool.execute(request.params, {
            userId: request.userId,
            agentId: request.agentId,
            conversationId: request.conversationId,
          }),
        timeoutMs
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Execution failed";
      if (message === "Execution timed out") {
        const completedAt = new Date();
        await this.audit(request, executionId, "failure", startedAt);
        return {
          executionId,
          toolId: request.toolId,
          status: "timed_out",
          error: "Execution timed out",
          startedAt,
          completedAt,
          durationMs: completedAt.getTime() - startedAt.getTime(),
        };
      }
      result = { success: false, error: message };
    }

    const completedAt = new Date();
    const auditResult: "success" | "failure" = result.success
      ? "success"
      : "failure";
    await this.audit(request, executionId, auditResult, startedAt);

    return {
      executionId,
      toolId: request.toolId,
      status: result.success ? "completed" : "failed",
      result,
      error: result.error,
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
    };
  }

  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Execution timed out"));
      }, timeoutMs);
      fn()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private async audit(
    request: ToolExecutionRequest,
    executionId: string,
    result: "success" | "failure" | "rejected" | "pending",
    startedAt: Date
  ): Promise<void> {
    await this.auditLogger.log({
      userId: request.userId,
      agentId: request.agentId,
      toolId: request.toolId,
      action: "tool.execute",
      parameters: request.params,
      result,
      traceId: request.traceId,
      ipAddress: request.ipAddress,
      metadata: {
        executionId,
        durationMs: new Date().getTime() - startedAt.getTime(),
      },
    });
  }
}
