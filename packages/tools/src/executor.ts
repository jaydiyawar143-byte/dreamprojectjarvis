import type {
  ITool,
  IToolExecutor,
  ToolExecutionRequest,
  ToolExecutionResult,
  IPermissionChecker,
  IApprovalManager,
  AuditLogger,
  ToolResult,
  ShutdownLifecycle,
} from "@jarvis/core";
import {
  APPROVAL_TTL_MS,
  SERVICE_SHUTTING_DOWN_ERROR,
  computeParamsHash,
} from "@jarvis/core";

const DEFAULT_TIMEOUT_MS = 30000;

export class ToolExecutor implements IToolExecutor {
  private readonly defaultTimeoutMs: number;
  /**
   * Phase 10.6 — optional lifecycle gate. When provided it is the single
   * admission authority: new executions (and therefore new approval
   * consumption) are refused once shutdown has begun, while in-flight
   * executions keep running and are tracked so graceful shutdown can await
   * them. Absent (tests/legacy callers) → no gating.
   */
  private readonly lifecycle?: ShutdownLifecycle;

  constructor(
    private registry: { get(toolId: string): ITool | undefined },
    private permissionChecker: IPermissionChecker,
    private approvalManager: IApprovalManager,
    private auditLogger: AuditLogger,
    config?: {
      defaultTimeoutMs?: number;
      lifecycle?: ShutdownLifecycle;
    }
  ) {
    this.defaultTimeoutMs = config?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.lifecycle = config?.lifecycle;
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

    // ---------------------------------------------------------------------
    // Phase 10.6 — earliest safe blocking point.
    //
    // Checked BEFORE permission checks, BEFORE any approval lookup and
    // BEFORE journal/approval mutation, so draining can never consume an
    // approval or create a pending record for work that will not run.
    //
    // Side-effecting tools are refused with a deterministic error as soon
    // as shutdown begins; READ_ONLY tools remain available during DRAINING
    // (health/read endpoints stay useful). Once STOP_ACCEPTING is reached
    // nothing new is admitted at all.
    //
    // Rejections are never silent — they are audited like other refusals.
    //
    // In-flight executions are deliberately NOT interrupted here: this is
    // the entry point for NEW requests only. Already-running executions
    // finish or hit their own authoritative deadline; ambiguous external
    // writes stay UNKNOWN for reconciliation — shutdown never marks them
    // FAILED and never retries them.
    // ---------------------------------------------------------------------
    if (this.lifecycle && !this.lifecycle.canAcceptNewWork(tool.risk)) {
      const completedAt = new Date();
      await this.audit(request, executionId, "rejected", startedAt);
      return {
        executionId,
        toolId: request.toolId,
        status: "failed",
        error: SERVICE_SHUTTING_DOWN_ERROR,
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

    // Phase 10.3: when a valid cached approval authorizes this execution,
    // its id is forwarded to the tool, which atomically CONSUMES it (verifying
    // user/tool/paramsHash/state/expiry) together with the execution claim —
    // one-time enforcement is durable, not executor-local.
    //
    // Phase 11.6A: when the manager exposes findApprovalsForTool, resolve
    // the approval that actually BINDS to these exact params across ALL
    // candidates instead of a single latest-row lookup — an unrelated
    // pending/rejected proposal for different params must never shadow an
    // approval a human explicitly granted for this execution.
    let approvalIdForExecution: string | undefined;

    if (tool.requiresApproval) {
      const paramsBound = (approval: {
        paramsHash?: string;
        toolId?: string;
        userId?: string;
      } | null): boolean =>
        !!approval &&
        approval.toolId === request.toolId &&
        approval.userId === request.userId &&
        !!approval.paramsHash &&
        approval.paramsHash === computeParamsHash(request.params);

      type ApprovalLike = {
        id: string;
        status: string;
        expiresAt: string | Date;
        paramsHash?: string;
        toolId?: string;
        userId?: string;
      };

      let approvedBound: ApprovalLike | undefined;
      let rejectedLatest: ApprovalLike | undefined;
      let pendingBound: ApprovalLike | undefined;

      // PHASE 11.9C: When caller provides an explicit approvalId (from the
      // pending-action flow), look up THAT specific approval first. If it is
      // approved and valid, use it directly — bypass the broad search that
      // can miss it and cause a new approval to be created (the "loop").
      if (request.approvalId) {
        const existing = await this.approvalManager.findExistingForTool(
          request.toolId,
          request.userId
        );
        if (existing && existing.id === request.approvalId) {
          if (
            existing.status === "approved" &&
            new Date(existing.expiresAt) > new Date() &&
            paramsBound(existing)
          ) {
            approvedBound = existing;
          } else if (existing.status === "rejected") {
            rejectedLatest = existing;
          }
        }
        // If the specific approval wasn't found via findExistingForTool
        // (which does findFirst), also try the broader list query
        if (!approvedBound && !rejectedLatest) {
          if (this.approvalManager.findApprovalsForTool) {
            const candidates =
              await this.approvalManager.findApprovalsForTool(
                request.toolId,
                request.userId
              );
            const match = candidates.find((c) => c.id === request.approvalId);
            if (match) {
              if (
                match.status === "approved" &&
                new Date(match.expiresAt) > new Date() &&
                paramsBound(match)
              ) {
                approvedBound = match;
              } else if (match.status === "rejected") {
                rejectedLatest = match;
              }
            }
          }
        }
      } else if (this.approvalManager.findApprovalsForTool) {
        const candidates =
          await this.approvalManager.findApprovalsForTool(
            request.toolId,
            request.userId
          );
        for (const candidate of candidates) {
          if (!approvedBound && paramsBound(candidate) &&
            candidate.status === "approved" &&
            new Date(candidate.expiresAt) > new Date()
          ) {
            approvedBound = candidate;
          }
          if (!pendingBound && paramsBound(candidate) && candidate.status === "pending") {
            pendingBound = candidate;
          }
          if (!rejectedLatest && candidate.status === "rejected") {
            rejectedLatest = candidate;
          }
        }
      } else {
        const existing = await this.approvalManager.findExistingForTool(
          request.toolId,
          request.userId
        );
        if (existing) {
          if (
            existing.status === "approved" &&
            new Date(existing.expiresAt) > new Date() &&
            paramsBound(existing)
          ) {
            approvedBound = existing;
          } else if (existing.status === "rejected") {
            rejectedLatest = existing;
          } else if (existing.status === "pending" && paramsBound(existing)) {
            pendingBound = existing;
          }
        }
      }

      if (approvedBound) {
        approvalIdForExecution = approvedBound.id;
      } else if (rejectedLatest) {
        const completedAt = new Date();
        await this.audit(request, executionId, "rejected", startedAt);
        return {
          executionId,
          toolId: request.toolId,
          status: "approval_denied",
          approvalId: rejectedLatest.id,
          error: "Approval was rejected",
          startedAt,
          completedAt,
          durationMs: completedAt.getTime() - startedAt.getTime(),
        };
      } else if (pendingBound) {
        const completedAt = new Date();
        await this.audit(request, executionId, "pending", startedAt);
        return {
          executionId,
          toolId: request.toolId,
          status: "approval_pending",
          approvalId: pendingBound.id,
          startedAt,
          completedAt,
          durationMs: completedAt.getTime() - startedAt.getTime(),
        };
      }

      if (!approvalIdForExecution) {
        const approval = await this.approvalManager.requestApproval({
          userId: request.userId,
          agentId: request.agentId,
          toolId: request.toolId,
          action: "execute",
          params: request.params,
          // PHASE 10.7: single authoritative TTL (was a divergent 1h literal).
          expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
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

    // ---------------------------------------------------------------------
    // Phase 10.4 — ONE authoritative execution deadline.
    //
    // A single AbortController owns the whole execution. When the deadline
    // expires the controller aborts and the SAME signal is handed to the
    // tool via its context, propagating executor → tool → provider → HTTP
    // client → fetch, so the underlying request is actually cancelled
    // instead of continuing after a Promise.race rejection.
    //
    // The race below remains only as a safety net for tools that ignore the
    // signal: it rejects at the same instant the signal fires — it never
    // runs on a separate, competing timer.
    //
    // A timeout/abort NEVER proves the external write did not happen; tools
    // classify their own journal outcome (FAILED vs UNKNOWN) based on the
    // transport-phase information provided by the provider layer.
    // ---------------------------------------------------------------------
    // ---------------------------------------------------------------------
    // Phase 10.6 — supplementary in-flight registry. The durable journal
    // remains the source of truth; this handle only lets graceful shutdown
    // WAIT for safe completion. Both terminal paths below must call
    // complete() exactly once.
    // ---------------------------------------------------------------------
    const inFlight = this.lifecycle?.trackExecution(executionId, tool.risk);

    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const deadlineController = new AbortController();
    const timer = setTimeout(
      () => deadlineController.abort(),
      timeoutMs
    );

    const externalSignal = request.signal;
    const contextSignal =
      externalSignal && !externalSignal.aborted
        ? AbortSignal.any([deadlineController.signal, externalSignal])
        : deadlineController.signal;

    const deadlineFailure = (): Error => {
      const reason = externalSignal?.aborted
        ? "Execution aborted by caller"
        : "Execution timed out";
      const err = new Error(reason);
      err.name = "ToolExecutionAbortedError";
      return err;
    };

    let result: ToolResult;
    try {
      result = await new Promise<ToolResult>((resolve, reject) => {
        const onDeadlineAbort = () => reject(deadlineFailure());
        if (deadlineController.signal.aborted) {
          onDeadlineAbort();
          return;
        }
        deadlineController.signal.addEventListener("abort", onDeadlineAbort, { once: true });
        tool
          .execute(request.params, {
            userId: request.userId,
            agentId: request.agentId,
            conversationId: request.conversationId,
            traceId: request.traceId,
            approvalId: approvalIdForExecution,
            signal: contextSignal,
          })
          .then(
            (value) => {
              deadlineController.signal.removeEventListener("abort", onDeadlineAbort);
              resolve(value);
            },
            (err) => {
              deadlineController.signal.removeEventListener("abort", onDeadlineAbort);
              reject(err);
            }
          );
      }).finally(() => clearTimeout(timer));
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : "Execution failed";
      if (err instanceof Error && err.name === "ToolExecutionAbortedError") {
        const completedAt = new Date();
        await this.audit(request, executionId, "failure", startedAt);
        inFlight?.complete();
        return {
          executionId,
          toolId: request.toolId,
          status: "timed_out",
          error: message,
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

    inFlight?.complete();
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
