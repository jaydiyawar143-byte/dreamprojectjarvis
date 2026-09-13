// ---------------------------------------------------------------------------
// "Action failed: gmail.createDraft — Error: Tool not found"
//
// Shown to the user immediately AFTER they approved the draft, which is the
// worst moment for a system to say something that sounds broken. Nothing was
// wrong: not the approval, not the scopes, not the plan. The confirm path
// simply had the wrong execution handler.
//
// `GoogleWriteService.plan` stores the ACTION as the approval's tool id
// ("gmail.createDraft") so a consume cannot cross actions. The registered tool
// is the PLANNER, `google.plan.gmail.createDraft`; nothing named
// "gmail.createDraft" is in the registry, because execution is a service call.
// The chat confirm path handed that id to the ToolExecutor, which looked it up
// and found nothing.
//
// These tests pin the routing decision and the boundary it must not weaken.
// The approval gates themselves live in `consumeForExecution` and are covered
// by google-write-approval.test.ts — nothing here re-implements them, because a
// check written at this layer would be a check the Approvals page does not do.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import {
  executeApprovedGoogleWrite,
  isGoogleWriteApprovalAction,
} from "../src/services/google/execute-approved-action.js";
import { GOOGLE_WRITE_TOOL_IDS } from "@jarvis/tools";
import type { GoogleWriteResult } from "@jarvis/core";

const APPROVAL = "ap-1";
const USER = "user-1";

function input(over: Record<string, unknown> = {}) {
  return { approvalId: APPROVAL, action: "gmail.createDraft", userId: USER, ...over } as never;
}

/** A GoogleWriteService double. Only `execute` is reachable from this path. */
function writes(result: Partial<GoogleWriteResult>) {
  const execute = vi.fn(async () => ({
    success: true,
    source: "gmail",
    action: "gmail.createDraft",
    status: "COMPLETED",
    verification: "verification_unavailable",
    data: { draftId: "d-1" },
    requestId: "r-1",
    auditRef: "audit-1",
    retrySafe: false,
    ...result,
  }) as GoogleWriteResult);

  return { execute } as never as import("../src/services/google/write-service.js").GoogleWriteService & {
    execute: typeof execute;
  };
}

// ---------------------------------------------------------------------------

describe("the routing decision that caused the bug", () => {
  it("recognises every Google write action as service-executed", () => {
    for (const action of [
      "gmail.createDraft",
      "gmail.updateDraft",
      "gmail.sendDraft",
      "drive.createFolder",
      "calendar.createEvent",
    ]) {
      expect(isGoogleWriteApprovalAction(action), action).toBe(true);
    }
  });

  it("does NOT claim a registry tool, so other approvals keep their path", () => {
    for (const toolId of ["meta.campaign.create", "whatsapp.send", "n8n.trigger"]) {
      expect(isGoogleWriteApprovalAction(toolId), toolId).toBe(false);
    }
  });

  it("confirms no tool named after the action is registered — the actual cause", () => {
    // The registry holds the PLANNER id. Looking up the action finds nothing,
    // which is exactly what produced "Tool not found".
    expect(GOOGLE_WRITE_TOOL_IDS).toContain("google.plan.gmail.createDraft");
    expect(GOOGLE_WRITE_TOOL_IDS).not.toContain("gmail.createDraft");
  });
});

describe("an approved Gmail draft executes through the existing service", () => {
  it("calls GoogleWriteService.execute with the approval id", async () => {
    const svc = writes({});
    const res = await executeApprovedGoogleWrite(svc, input());

    expect(svc.execute).toHaveBeenCalledTimes(1);
    expect(svc.execute.mock.calls[0]![0]).toBe(APPROVAL);
    expect(res.status).toBe("completed");
  });

  it("never reports 'Tool not found' for a Google write", async () => {
    const res = await executeApprovedGoogleWrite(writes({}), input());
    expect(res.error ?? "").not.toMatch(/tool not found/i);
  });

  it("carries verification through verbatim, without upgrading it", async () => {
    // "Google reported success" must not become "verified" on the way to chat.
    const res = await executeApprovedGoogleWrite(
      writes({ verification: "provider_reported" }),
      input()
    );

    const data = res.result?.data as Record<string, unknown>;
    expect(data.verification).toBe("provider_reported");
  });

  it("passes the audit reference so the user can cite what happened", async () => {
    const res = await executeApprovedGoogleWrite(writes({}), input());
    expect((res.result?.data as Record<string, unknown>).auditRef).toBe("audit-1");
  });
});

describe("the approval boundary is not weakened by this path", () => {
  it("refuses an unapproved approval — the service says so and we relay it", async () => {
    // The gate is `consumeForExecution`; this layer must not second-guess it,
    // and must not swallow its refusal either.
    const svc = writes({
      success: false,
      status: "FAILED",
      verification: "failed",
      message: "This approval has not been approved.",
      requiredAction: "Approve it on the Approvals page first.",
    });

    const res = await executeApprovedGoogleWrite(svc, input());

    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/has not been approved/i);
    expect(res.error).toMatch(/Approve it/i);
  });

  it("declares voice: false explicitly, so a spoken yes can never spend an approval", async () => {
    const svc = writes({});
    await executeApprovedGoogleWrite(svc, input());

    const ctx = svc.execute.mock.calls[0]![1] as Record<string, unknown>;
    expect(ctx.voice).toBe(false);
  });

  it("performs no gate of its own — one execute call, no pre-checks", async () => {
    // A check here would be a check the Approvals-page path does not perform,
    // and two divergent gates is how a boundary rots.
    const svc = writes({});
    await executeApprovedGoogleWrite(svc, input());

    expect(svc.execute).toHaveBeenCalledTimes(1);
  });
});

describe("duplicate execution cannot create a second draft", () => {
  it("relays the service's refusal on a re-run of a consumed approval", async () => {
    // Approvals are single-use and consumed atomically. The second attempt
    // reaches the same service and is refused there, not here.
    const svc = writes({
      success: false,
      status: "FAILED",
      verification: "failed",
      message: "This approval has already been used.",
    });

    const first = await executeApprovedGoogleWrite(svc, input());
    expect(first.status).toBe("failed");
    expect(first.error).toMatch(/already been used/i);
  });

  it("sends exactly one execute call per invocation", async () => {
    const svc = writes({});

    await executeApprovedGoogleWrite(svc, input());
    await executeApprovedGoogleWrite(svc, input());

    // Two deliberate invocations, two calls — the service's atomic consume is
    // what makes the second harmless, not a count kept here.
    expect(svc.execute).toHaveBeenCalledTimes(2);
    expect(svc.execute.mock.calls[0]![0]).toBe(svc.execute.mock.calls[1]![0]);
  });
});

describe("a missing or unusable handler answers safely", () => {
  it("explains an unconfigured deployment instead of crashing", async () => {
    const res = await executeApprovedGoogleWrite(null, input());

    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/unavailable on this server/i);
    expect(res.error).toMatch(/Configure the Google OAuth client/i);
    // Never the opaque message this whole change exists to remove.
    expect(res.error).not.toMatch(/tool not found/i);
  });

  it("surfaces a permission failure with its remedy", async () => {
    const svc = writes({
      success: false,
      status: "FAILED",
      verification: "failed",
      message: "Your Google connection does not include Gmail access.",
      requiredAction: "Grant Gmail access in Integrations, then plan it again.",
    });

    const res = await executeApprovedGoogleWrite(svc, input());

    expect(res.error).toMatch(/does not include Gmail access/i);
    expect(res.error).toMatch(/Grant Gmail access/i);
  });

  it("surfaces a needs-reauth failure with its remedy", async () => {
    const svc = writes({
      success: false,
      status: "FAILED",
      verification: "failed",
      message: "Your Google authorization has expired.",
      requiredAction: "Reconnect Google, then plan the action again.",
    });

    const res = await executeApprovedGoogleWrite(svc, input());

    expect(res.error).toMatch(/expired/i);
    expect(res.error).toMatch(/Reconnect Google/i);
  });

  it("reports the action, not an internal id, on the result", async () => {
    const res = await executeApprovedGoogleWrite(writes({}), input());
    expect(res.toolId).toBe("gmail.createDraft");
  });
});
