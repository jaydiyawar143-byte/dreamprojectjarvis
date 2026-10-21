// ---------------------------------------------------------------------------
// Phase 18, Stage 18.3B — adding an approved library workflow to the trigger
// allow-list, from the Automations page.
//
// WHAT THE APPLY BUTTON DOES, in the Marketing publish flow's shape:
//   REQUEST   `AutomationLibraryService.proposeAllowlist` — an approval row in
//             the one approval store, bound to {entryId, versionId}, belonging
//             to the Organization that owns n8n.
//   DECIDE    another owner or admin approves it on the Approvals page
//             (`decideApproval`: one conditional UPDATE; a requester can never
//             approve their own Organization write).
//   EXECUTE   this file: once THAT row is approved, the page-only tool
//             `automation.library.allowlist.add` runs through ToolExecutor
//             with that approval's id and that approval's own parameters. The
//             tool consumes the approval with the Organization's scope in the
//             journal's durable step, after the service has checked everything
//             again — so one approval adds at most once.
//
// THIS FILE APPROVES NOTHING AND ADDS NOTHING. It reads the named approval to
// say plainly why it cannot be used yet (waiting, rejected, used, expired) —
// each of those answers changes nothing and reaches no tool — and otherwise
// hands it to the executor. Naming the approval keeps the executor on the
// branch that looks at that one row (the publish flow's finding F-2).
//
// A SPOKEN APPLY IS REFUSED. This is an on-screen action; a request that says
// it was spoken is refused before anything is read, and ToolExecutor never
// spends an approval for a spoken turn anyway (Stage 18.3A).
// ---------------------------------------------------------------------------

import {
  AUTOMATION_LIBRARY_TOOL_IDS,
  VOICE_TOOL_REFUSED_CODE,
  voiceConfirmationRefusal,
  type Approval,
  type InputMode,
  type IToolExecutor,
  type LibraryAllowlistApplied,
  type LibraryResult,
  type Role,
} from "@jarvis/core";
import type { LibraryAuditPort } from "./library-service.js";

export interface LibraryAllowlistFlowDeps {
  executor: Pick<IToolExecutor, "execute">;
  approvals: { findByIdForUser(id: string, userId: string): Promise<Approval | null> };
  audit: LibraryAuditPort;
  now?: () => Date;
}

export interface LibraryAllowlistCaller {
  userId: string;
  role: Role;
  traceId: string;
  ipAddress?: string;
  /** What the request says about itself. Only "voice" changes anything: it is refused. */
  inputMode?: InputMode;
}

function refuse(status: number, code: string, message: string): { ok: false; status: number; code: string; message: string } {
  return { ok: false, status, code, message };
}

export class LibraryAllowlistFlow {
  private readonly now: () => Date;

  constructor(private readonly deps: LibraryAllowlistFlowDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async audit(userId: string, result: "rejected" | "failure", metadata: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.audit.log({ userId, action: "automation_library.allowlist_apply", result, metadata });
    } catch {
      /* an audit failure never changes the answer */
    }
  }

  async apply(caller: LibraryAllowlistCaller, entryId: string, approvalId: string): Promise<LibraryResult<LibraryAllowlistApplied>> {
    const spoken = voiceConfirmationRefusal(caller.inputMode);
    if (spoken) {
      await this.audit(caller.userId, "rejected", { reason: "VOICE_NOT_ALLOWED", approvalId });
      return refuse(403, VOICE_TOOL_REFUSED_CODE, spoken);
    }

    let approval: Approval | null;
    try {
      approval = await this.deps.approvals.findByIdForUser(approvalId, caller.userId);
    } catch {
      return refuse(503, "PROPOSALS_UNAVAILABLE", "The proposal could not be read right now. Try again.");
    }
    // Another user's approval is the same "not found" as a missing one.
    const params = approval?.params as Record<string, unknown> | undefined;
    if (!approval || approval.toolId !== AUTOMATION_LIBRARY_TOOL_IDS.allowlistAdd || params?.entryId !== entryId) {
      return refuse(404, "PROPOSAL_NOT_FOUND", "No proposal of yours for this workflow has that id.");
    }

    const lapsed = (approval.status === "pending" || approval.status === "approved") && Date.parse(approval.expiresAt) <= this.now().getTime();
    if (lapsed || approval.status === "expired") {
      await this.audit(caller.userId, "rejected", { reason: "PROPOSAL_EXPIRED", approvalId, entryId });
      return refuse(410, "PROPOSAL_EXPIRED", "This proposal expired before it was added. Propose it again.");
    }
    if (approval.status === "pending") {
      return refuse(409, "PROPOSAL_AWAITING_APPROVAL", "Another owner or admin of your organization must approve this proposal first.");
    }
    if (approval.status === "rejected") {
      await this.audit(caller.userId, "rejected", { reason: "PROPOSAL_REJECTED", approvalId, entryId });
      return refuse(409, "PROPOSAL_REJECTED", "This proposal was rejected, so it cannot be added.");
    }
    if (approval.status === "consumed") {
      return refuse(409, "PROPOSAL_USED", "This proposal has already been used.");
    }

    const execution = await this.deps.executor.execute({
      toolId: AUTOMATION_LIBRARY_TOOL_IDS.allowlistAdd,
      params: approval.params,
      userId: caller.userId,
      role: caller.role,
      traceId: caller.traceId,
      approvalId: approval.id,
      ...(caller.ipAddress ? { ipAddress: caller.ipAddress } : {}),
    });

    if (execution.status === "completed" && execution.result?.success) {
      return { ok: true, value: execution.result.data as LibraryAllowlistApplied };
    }
    const meta = execution.result?.metadata as { code?: unknown; status?: unknown } | undefined;
    const message = execution.result?.error ?? execution.error ?? "The workflow could not be added.";
    if (typeof meta?.code === "string" && typeof meta.status === "number") return refuse(meta.status, meta.code, message);
    if (execution.status === "permission_denied") return refuse(403, "PERMISSION_DENIED", message);
    if (execution.status === "approval_pending" || execution.status === "approval_required") {
      return refuse(409, "PROPOSAL_AWAITING_APPROVAL", "Another owner or admin of your organization must approve this proposal first.");
    }
    await this.audit(caller.userId, "failure", { reason: execution.status, approvalId, entryId });
    return refuse(500, "APPLY_FAILED", "The workflow could not be added.");
  }
}
