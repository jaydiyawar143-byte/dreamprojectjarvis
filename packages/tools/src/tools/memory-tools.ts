// ---------------------------------------------------------------------------
// S7.2 L5 — memory tools.
//
//   memory.list        READ_ONLY. The user's own memories, as safe views.
//   memory.forget      HIGH_IMPACT, approval-gated. Fixed memory ids, each
//                      bound to the version the user was shown. Never text.
//   memory.forget_all  HIGH_IMPACT, approval-gated. A fixed scope only.
//
// THE PORT IS THE WHOLE BOUNDARY, as for the task tools: three methods over
// MemoryManagementService at the composition root, each scoped to the user.
// `context.userId` IS THE USER; no parameter can name another.
//
// The deleting tools are on NO agent's allowlist. They run only when the user
// confirms a pending action the chat route's memory-command path created, and
// they reuse the Phase 10 write machinery verbatim: a journal record, and an
// approval consumed in the same durable step that claims it (user, tool,
// params hash, state, expiry). No approval, no deletion.
//
// RISK. Nothing leaves JARVIS, but a forgotten memory is gone for good:
// HIGH_IMPACT, not LOW_IMPACT. Permission is only "read" on purpose — every
// role may forget its OWN memories.
// ---------------------------------------------------------------------------

import { BaseTool } from "../base-tool.js";
import type {
  ExecutionJournalPort,
  IApprovalConsumptionPort,
  MemoryForgetScope,
  MemoryView,
  ToolContext,
  ToolParameter,
  ToolResult,
} from "@jarvis/core";
import { BLOCKED_STATUSES, MEMORY_FORGET_LIMIT, MEMORY_TOOL_IDS, computeParamsHash } from "@jarvis/core";
import { withSafeTerminalTransitions } from "../execution-journal.js";

/** What the tools may do. Implemented over MemoryManagementService at the composition root. */
export interface MemoryToolPort {
  list(userId: string, options: { includeExpired: boolean; limit?: number }): Promise<{ memories: MemoryView[]; total: number; hasMore: boolean }>;
  forget(
    userId: string,
    targets: Array<{ id: string; version: string }>
  ): Promise<{ status: "FORGOTTEN" | "STALE" | "NOT_FOUND" | "NOTHING_TO_FORGET"; deleted: number; notFound?: number; stale?: number }>;
  forgetAll(userId: string, scope: MemoryForgetScope): Promise<{ status: "FORGOTTEN" | "NOTHING_TO_FORGET"; deleted: number }>;
}

const MEMORY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function onlyKeys(params: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(params).every((k) => allowed.includes(k));
}

// ---------------------------------------------------------------------------
// memory.list
// ---------------------------------------------------------------------------

export class MemoryListTool extends BaseTool {
  constructor(private readonly memories: MemoryToolPort) {
    super(
      MEMORY_TOOL_IDS.list,
      "List memories",
      "List what JARVIS remembers about the current user: their own saved memories, newest first. Read-only.",
      "system",
      [
        { name: "includeExpired", type: "boolean", description: "Include memories that have expired", required: false },
        { name: "limit", type: "number", description: "How many to return, 1-50 (default 20)", required: false },
      ],
      false,
      ["read"],
      "READ_ONLY"
    );
  }

  validate(params: Record<string, unknown>): boolean {
    const { includeExpired, limit } = params;
    return (
      onlyKeys(params, ["includeExpired", "limit"]) &&
      (includeExpired === undefined || typeof includeExpired === "boolean") &&
      (limit === undefined || (Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= 50))
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const result = await this.memories.list(context.userId, {
      ...(params.limit !== undefined ? { limit: params.limit as number } : {}),
      includeExpired: params.includeExpired === true,
    });
    return this.success(result);
  }
}

// ---------------------------------------------------------------------------
// The deleting tools
// ---------------------------------------------------------------------------

abstract class MemoryDeleteTool extends BaseTool {
  protected readonly journal: ExecutionJournalPort;

  constructor(
    id: string,
    name: string,
    description: string,
    parameters: ToolParameter[],
    protected readonly memories: MemoryToolPort,
    journal: ExecutionJournalPort,
    private readonly approvals?: IApprovalConsumptionPort
  ) {
    super(id, name, description, "system", parameters, true, ["read"], "HIGH_IMPACT");
    this.journal = withSafeTerminalTransitions(journal);
  }

  /**
   * The Phase 10 sequence, as in the browser and Meta write tools: begin the
   * journal record, then consume the approval in the SAME durable step that
   * claims it. Fails closed: no approval, no port, or any failure → nothing.
   */
  protected async authorize(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<{ ok: true; executionId: string } | { ok: false; error: string }> {
    if (!context.approvalId) return { ok: false, error: "Forgetting a memory needs your confirmation." };
    if (!this.approvals) return { ok: false, error: "Approval verification unavailable" };
    const paramsHash = computeParamsHash(params);

    let record;
    try {
      record = await this.journal.begin({
        userId: context.userId,
        toolId: this.id,
        idempotencyKey: `${this.id}:${context.approvalId}`,
        paramsHash,
        provider: "memory",
        traceId: context.traceId,
        approvalId: context.approvalId,
      });
    } catch {
      return { ok: false, error: "Execution journal unavailable" };
    }
    if (BLOCKED_STATUSES.has(record.status)) return { ok: false, error: `Execution already ${record.status.toLowerCase()}` };

    let result;
    try {
      result = await this.approvals.consumeForExecution({
        approvalId: context.approvalId,
        userId: context.userId,
        toolId: this.id,
        paramsHash,
        executionId: record.executionId,
      });
    } catch {
      return { ok: false, error: "Approval verification unavailable" };
    }
    if (!result.ok) return { ok: false, error: `Approval denied: ${result.reason}` };
    return { ok: true, executionId: record.executionId };
  }

  protected async fail(executionId: string, code: string, message: string): Promise<ToolResult> {
    await this.journal.markFailed(executionId, { code, message });
    return this.failure(message);
  }
}

export class MemoryForgetTool extends MemoryDeleteTool {
  constructor(memories: MemoryToolPort, journal: ExecutionJournalPort, approvals?: IApprovalConsumptionPort) {
    super(
      MEMORY_TOOL_IDS.forget,
      "Forget memories",
      "Permanently forget specific memories the user chose and confirmed. Never offered to agents.",
      [
        { name: "memoryIds", type: "array", description: "The ids of the memories to forget", required: true },
        { name: "versions", type: "array", description: "The version (changedAt) each memory was shown at", required: true },
      ],
      memories,
      journal,
      approvals
    );
  }

  validate(params: Record<string, unknown>): boolean {
    const { memoryIds, versions } = params;
    return (
      onlyKeys(params, ["memoryIds", "versions"]) &&
      Array.isArray(memoryIds) &&
      Array.isArray(versions) &&
      memoryIds.length > 0 &&
      memoryIds.length <= MEMORY_FORGET_LIMIT &&
      memoryIds.length === versions.length &&
      new Set(memoryIds).size === memoryIds.length &&
      memoryIds.every((id) => typeof id === "string" && MEMORY_ID.test(id)) &&
      versions.every((v) => typeof v === "string" && VERSION.test(v))
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const authorized = await this.authorize(params, context);
    if (!authorized.ok) return this.failure(authorized.error);

    const ids = params.memoryIds as string[];
    const versions = params.versions as string[];
    let outcome;
    try {
      outcome = await this.memories.forget(context.userId, ids.map((id, i) => ({ id, version: versions[i]! })));
    } catch {
      return this.fail(authorized.executionId, "MEMORY_FORGET_FAILED", "The memory could not be forgotten. Nothing was deleted.");
    }
    if (outcome.status === "STALE") {
      return this.fail(authorized.executionId, "STALE_TARGET", "That memory changed after you chose it, so nothing was forgotten. Ask again to see it as it is now.");
    }
    if (outcome.status !== "FORGOTTEN") {
      return this.fail(authorized.executionId, "NOT_FOUND", "Those memories no longer exist, so there was nothing to forget.");
    }
    await this.journal.markSucceeded(authorized.executionId);
    return this.success({ forgotten: outcome.deleted });
  }
}

export class MemoryForgetAllTool extends MemoryDeleteTool {
  constructor(memories: MemoryToolPort, journal: ExecutionJournalPort, approvals?: IApprovalConsumptionPort) {
    super(
      MEMORY_TOOL_IDS.forgetAll,
      "Forget all memories",
      "Permanently forget every memory in the confirmed scope (ALL, or only LEGACY ones). Never offered to agents.",
      [{ name: "scope", type: "string", description: "ALL or LEGACY", required: true }],
      memories,
      journal,
      approvals
    );
  }

  validate(params: Record<string, unknown>): boolean {
    return onlyKeys(params, ["scope"]) && (params.scope === "ALL" || params.scope === "LEGACY");
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const authorized = await this.authorize(params, context);
    if (!authorized.ok) return this.failure(authorized.error);

    const scope = params.scope as MemoryForgetScope;
    let outcome;
    try {
      outcome = await this.memories.forgetAll(context.userId, scope);
    } catch {
      return this.fail(authorized.executionId, "MEMORY_FORGET_FAILED", "The memories could not be forgotten. Nothing was deleted.");
    }
    await this.journal.markSucceeded(authorized.executionId);
    return this.success({ forgotten: outcome.deleted, scope });
  }
}

/** list, forget, forget_all — in that order. */
export function createMemoryTools(memories: MemoryToolPort, journal: ExecutionJournalPort, approvals?: IApprovalConsumptionPort): BaseTool[] {
  return [new MemoryListTool(memories), new MemoryForgetTool(memories, journal, approvals), new MemoryForgetAllTool(memories, journal, approvals)];
}
