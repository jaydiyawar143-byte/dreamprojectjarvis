// ---------------------------------------------------------------------------
// Phase 19.1 — a write as the executor runs it, for the suites that test what
// a write does AFTER that point.
//
// A Meta Ads write (and a browser write) runs only with the executor's grant
// for that exact call (src/execution-grant.ts) and an approval a person
// approved, which the approval store spends once while it claims the journal
// row. These suites are about the account check, validation, guardrails, the
// journal and the provider, so each call starts from what a real approved run
// hands the tool: an approved, bound approval in the reference store, and the
// grant the executor issues for it.
//
// A call that does not come through the executor is covered by
// meta-ads-write-boundary-p19.test.ts, and is refused.
// ---------------------------------------------------------------------------

import type { ExecutionJournalPort, ExecutionJournalStatus, ITool, ToolContext, ToolResult } from "@jarvis/core";
import { computeParamsHash } from "@jarvis/core";
import { MemoryApprovalConsumer, MemoryExecutionJournal } from "../../src/execution-journal.js";
import { issueExecutionGrant } from "../../src/execution-grant.js";

export class ApprovedWrites {
  /** The reference approval store: binds, spends once, claims the journal row. */
  readonly approvals: MemoryApprovalConsumer;
  private issued = 0;

  constructor(readonly journal: ExecutionJournalPort = new MemoryExecutionJournal()) {
    this.approvals = new MemoryApprovalConsumer(journal);
  }

  /**
   * The context the executor hands `tool` after a person approved exactly
   * these parameters: a fresh approved approval, and the grant for this call.
   */
  context(tool: ITool, params: Record<string, unknown>, base: ToolContext = { userId: "user-1" }): ToolContext {
    this.issued += 1;
    const approvalId = `approval-${this.issued}`;
    const paramsHash = computeParamsHash(params);
    this.approvals.create({
      id: approvalId,
      userId: base.userId,
      toolId: tool.id,
      paramsHash,
      status: "approved",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    const context: ToolContext = { ...base, approvalId };
    issueExecutionGrant(context, {
      toolId: tool.id,
      userId: base.userId,
      paramsHash,
      approvalId,
      ...(base.inputMode ? { inputMode: base.inputMode } : {}),
      sharedAccessChecked: true,
    });
    return context;
  }

  /** Run `tool` as the executor would, once a person approved these parameters. */
  run(tool: ITool, params: Record<string, unknown>, base?: ToolContext): Promise<ToolResult> {
    return tool.execute(params, this.context(tool, params, base));
  }

  /**
   * Put this journal's row for `idempotencyKey` in `status`, as the deprecated
   * `setExecutionState` seam does for the tools' default journal. The tool id
   * is the key's first segment, as there. Needs a journal whose `begin`
   * returns its stored row (`MemoryExecutionJournal`).
   */
  async seed(idempotencyKey: string, status: ExecutionJournalStatus, userId = "user-1"): Promise<void> {
    const record = await this.journal.begin({
      userId,
      toolId: idempotencyKey.split(":")[0] ?? "unknown",
      idempotencyKey,
      provider: "meta-ads",
    });
    record.status = status;
  }

  /** The status of this journal's row for `idempotencyKey`, as `getExecutionState` reads the default one. */
  status(idempotencyKey: string): ExecutionJournalStatus | undefined {
    if (!(this.journal instanceof MemoryExecutionJournal)) throw new Error("status() reads a MemoryExecutionJournal");
    return this.journal.findByAnyKey(idempotencyKey)?.status;
  }
}
