// ---------------------------------------------------------------------------
// Executing an approved Google write from the chat / pending-action path.
//
// THE BUG THIS FIXES. There are two ways an approval reaches execution in this
// system, and until now only one of them knew about Google.
//
//   registry tools   approval.toolId IS a registered tool -> ToolExecutor
//   Google writes    approval.toolId is a WRITE ACTION    -> GoogleWriteService
//
// `GoogleWriteService.plan` deliberately stores the action as the approval's
// tool id ("gmail.createDraft") so a consume can never cross actions. But the
// registered tool is the PLANNER, `google.plan.gmail.createDraft`, and there is
// no registered tool called `gmail.createDraft` at all — execution is a service
// call, not a tool call.
//
// So when the user typed "yes" in chat, the confirm path handed
// "gmail.createDraft" to the ToolExecutor, which looked it up, found nothing,
// and returned "Tool not found". The user saw:
//
//     Action failed: gmail.createDraft
//     Error: Tool not found
//
// — after approving, which is the worst possible moment for a system to say
// something that sounds like it is broken. Nothing was wrong with the approval,
// the scopes or the plan; the caller simply had the wrong execution handler.
//
// NO NEW TOOL. Registering a `gmail.createDraft` tool would be a second way to
// perform a Google write, with its own permission path, its own idempotency and
// its own approval semantics — a duplicate of the thing that already works and
// a second surface to keep correct. This is an adapter: it calls the existing
// service and shapes the answer like a tool execution so both call sites render
// it unchanged.
//
// THE APPROVAL BOUNDARY IS UNTOUCHED. Every gate stays inside
// `GoogleWriteService.execute` -> `consumeForExecution`, which verifies user,
// tool, payload hash, APPROVED status and expiry in ONE transaction and flips
// the row to CONSUMED. This file performs no check of its own, because a check
// written here would be a check the Approvals-page path does not perform.
// ---------------------------------------------------------------------------

import { isGoogleWriteAction, type ToolExecutionResult } from "@jarvis/core";
import type { GoogleWriteService } from "./write-service.js";

/** Whether this approval executes through GoogleWriteService rather than a tool. */
export function isGoogleWriteApprovalAction(action: string | undefined): boolean {
  return isGoogleWriteAction(action);
}

export interface ExecuteApprovedGoogleWriteInput {
  approvalId: string;
  action: string;
  userId: string;
  conversationId?: string;
  traceId?: string;
}

/**
 * Execute an approved Google write and report it as a tool execution.
 *
 * `voice: false` is passed explicitly. The service refuses a voice context
 * outright, and stating it here keeps that visible at the call site rather than
 * relying on a default — a spoken "yes" must never be able to spend an
 * approval, and this is one of the places that could otherwise let it.
 */
export async function executeApprovedGoogleWrite(
  writes: GoogleWriteService | null,
  input: ExecuteApprovedGoogleWriteInput
): Promise<ToolExecutionResult> {
  const startedAt = new Date();

  const finish = (
    partial: Pick<ToolExecutionResult, "status" | "error"> & {
      result?: ToolExecutionResult["result"];
    }
  ): ToolExecutionResult => {
    const completedAt = new Date();
    return {
      executionId: input.approvalId,
      toolId: input.action,
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      ...partial,
    } as ToolExecutionResult;
  };

  // A safe, actionable answer instead of a missing-handler crash. This is the
  // state on a deployment with no Google OAuth client: the plan could never
  // have been created, but an approval row from a previous configuration can
  // still be sitting there.
  if (!writes) {
    return finish({
      status: "failed",
      error:
        "Google write actions are unavailable on this server. Configure the Google OAuth client, then plan the action again.",
    });
  }

  const result = await writes.execute(input.approvalId, {
    userId: input.userId,
    source: "jarvis",
    ...(input.traceId ? { traceId: input.traceId } : {}),
    voice: false,
  });

  if (!result.success) {
    // The service's own sentence, which already names the remedy for a
    // not-connected, needs-reauth, permission-missing or already-consumed
    // approval. Far better than anything this layer could synthesise.
    const remedy = result.requiredAction ? ` ${result.requiredAction}` : "";
    return finish({
      status: "failed",
      error: `${result.message ?? "The Google action could not be completed."}${remedy}`.trim(),
    });
  }

  return finish({
    status: "completed",
    result: {
      success: true,
      data: {
        action: result.action,
        // Verification is carried through verbatim. "Google reported success"
        // and "we read it back and confirmed it" are different claims, and the
        // chat reply must not upgrade one into the other.
        verification: result.verification,
        ...(result.auditRef ? { auditRef: result.auditRef } : {}),
        ...(result.message ? { summary: result.message } : {}),
      },
    },
  });
}
