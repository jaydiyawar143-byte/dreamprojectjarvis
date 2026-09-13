// ---------------------------------------------------------------------------
// The exact live failure: "Data retrieval failed" after a Gmail draft request.
//
// WHAT ACTUALLY HAPPENED. `GoogleWriteService.plan` rejects a draft with no
// recipient and returns status `invalid` with the sentence "At least one
// recipient is required." The planner tool's comment says invalid is an answer
// the user can act on — but `invalid` was missing from the condition beneath
// it, so the tool returned a FAILED ToolResult. That tripped the Orchestrator's
// all-tools-failed guard, which replaced the sentence with "Data retrieval
// failed." and put the real cause in `details.reason`, which no client reads.
//
// So the user asked JARVIS to draft an email, forgot to say who to, and was
// shown what looked like an outage. Nothing in the message said what was
// missing, and nothing suggested what to do.
//
// Both halves are pinned here, because either one alone leaves the bug
// reachable: the planner must not turn an answerable state into a failure, and
// the Orchestrator must not flatten a failure that does occur.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { CreateGmailDraftTool, type GoogleWritePlanPort } from "@jarvis/tools";
import { classifyToolFailures } from "@jarvis/core";
import type { GoogleWritePlanResult } from "@jarvis/core";

const ctx = { userId: "user-1", conversationId: "c-1", traceId: "t-1" };

/** A port that returns one canned plan outcome. */
function portReturning(result: Partial<GoogleWritePlanResult>): GoogleWritePlanPort {
  return {
    async plan() {
      return {
        success: false,
        status: "invalid",
        approvalId: null,
        plan: null,
        message: "At least one recipient is required.",
        requestId: "req-1",
        ...result,
      } as GoogleWritePlanResult;
    },
  };
}

describe("a draft with no recipient is a question, not an outage", () => {
  it("does NOT return a failed ToolResult for a validation problem", () => {
    // A failed ToolResult here is what produced "Data retrieval failed".
    return new CreateGmailDraftTool(portReturning({}))
      .execute({ subject: "Hi" }, ctx)
      .then((res) => {
        expect(res.success).toBe(true);
      });
  });

  it("carries the real sentence so the model can ask for what is missing", async () => {
    const res = await new CreateGmailDraftTool(portReturning({})).execute({ subject: "Hi" }, ctx);

    const data = res.data as Record<string, unknown>;
    expect(data.planned).toBe(false);
    expect(data.status).toBe("invalid");
    expect(String(data.reason)).toContain("recipient");
  });

  it("states plainly that nothing was drafted", async () => {
    const res = await new CreateGmailDraftTool(portReturning({})).execute({ subject: "Hi" }, ctx);
    const data = res.data as Record<string, unknown>;

    // The one thing that must never be ambiguous after a failed write attempt.
    expect(data.planned).toBe(false);
  });

  it("still returns a plan normally when the request is complete", async () => {
    const port: GoogleWritePlanPort = {
      async plan() {
        return {
          success: true,
          status: "approval_required",
          approvalId: "ap-1",
          message: "waiting for approval",
          requestId: "req-1",
          plan: {
            action: "gmail.createDraft",
            source: "gmail",
            target: { kind: "draft", id: null, label: "Hi" },
            recipients: ["a@example.com"],
            fields: [{ label: "Body", before: null, after: "hello" }],
            requiredScopes: ["https://www.googleapis.com/auth/gmail.compose"],
            risk: "HIGH_IMPACT",
            params: {},
            payloadHash: "hash",
            requestId: "req-1",
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            idempotencyKey: "k",
          },
        } as unknown as GoogleWritePlanResult;
      },
    };

    const res = await new CreateGmailDraftTool(port).execute(
      { to: ["a@example.com"], body: "hello" },
      ctx
    );

    expect(res.success).toBe(true);
    const data = res.data as Record<string, unknown>;
    // Planned, and explicitly NOT executed — approval still gates the write.
    expect(data.approvalId).toBe("ap-1");
  });
});

describe("the states that need a human still come back answerable", () => {
  for (const status of ["not_connected", "needs_reauth", "permission_missing", "invalid"] as const) {
    it(`returns ${status} as a successful lookup carrying the remedy`, async () => {
      const res = await new CreateGmailDraftTool(
        portReturning({ status, message: `Google reports ${status}.`, requiredAction: "Do the thing." })
      ).execute({ subject: "Hi" }, ctx);

      expect(res.success, `${status} must not trip the all-tools-failed guard`).toBe(true);
      expect((res.data as Record<string, unknown>).status).toBe(status);
    });
  }
});

describe("a failure that DOES occur is classified, not flattened", () => {
  it("maps a Gmail permission failure to a specific safe code", () => {
    const out = classifyToolFailures([
      {
        toolId: "google.plan.gmail.createDraft",
        error: "Your Google connection does not include Gmail access.",
      },
    ]);

    expect(out.code).toBe("GMAIL_PERMISSION_MISSING");
    expect(out.message).not.toBe("Data retrieval failed.");
  });

  it("keeps the generic message for a cause it cannot recognise", () => {
    // The fallback must stay exactly as it was, so an unclassified failure is
    // never made worse than before.
    const out = classifyToolFailures([{ toolId: "x.y", error: "kaboom" }]);
    expect(out.message).toBe("Data retrieval failed.");
  });

  it("never surfaces a provider payload as the user-facing message", () => {
    const out = classifyToolFailures([
      { toolId: "google.plan.gmail.createDraft", error: 'Google API error: {"error":{"code":403}}' },
    ]);

    expect(out.message).not.toContain("{");
    expect(out.message).not.toContain("403");
  });
});
