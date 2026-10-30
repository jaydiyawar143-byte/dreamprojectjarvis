// ---------------------------------------------------------------------------
// Phase 19.1 — what a failed browser write leaves in the journal.
//
// A write whose outcome is not known must be UNKNOWN, which blocks a retry: a
// click or a submit that may already have reached the other site is never sent
// twice. Two browser failures come after the action could have been sent and
// match no generic timeout/abort pattern — the session's own deadline and an
// action that then navigated somewhere the policy refuses. A failure that
// precedes the action (a missing element, a refused navigation) stays FAILED
// and may be approved and tried again.
//
// Named `computer-control*`, the slice CI runs for this package.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it } from "vitest";
import type {
  BrowserRuntimePort,
  BrowserSessionPort,
  BrowserWriteScopePort,
  ExecutionJournalPort,
  IApprovalConsumptionPort,
  ToolContext,
} from "@jarvis/core";
import { COMPUTER_CONTROL_ALREADY_UNKNOWN_MESSAGE, computeParamsHash } from "@jarvis/core";
import { MemoryExecutionJournal } from "../src/execution-journal.js";
import { issueExecutionGrant } from "../src/execution-grant.js";
import { BrowserClickTool, BrowserSubmitTool } from "../src/tools/browser-tools.js";

const identity = { url: "https://example.com/", title: "Example", status: 200 };

/** A session whose action methods can be made to throw once they are reached. */
class FailingSession implements BrowserSessionPort {
  actionError: Error | null = null;
  navigateError: Error | null = null;
  actions = 0;

  async navigate(url: string) {
    if (this.navigateError) throw this.navigateError;
    return { ...identity, url, redirected: false };
  }
  async inspect() {
    return { ...identity, elements: [], truncated: false };
  }
  async extract() {
    return { ...identity, text: "", fields: {}, truncated: false };
  }
  async screenshot() {
    return { ...identity, screenshotId: "shot-1", byteSize: 1, format: "png" as const };
  }
  private act(selector: string) {
    this.actions += 1;
    if (this.actionError) throw this.actionError;
    return { ...identity, selector, navigated: false };
  }
  async click(selector: string) {
    return this.act(selector);
  }
  async type(selector: string) {
    return this.act(selector);
  }
  async select(selector: string) {
    return this.act(selector);
  }
  async submit(selector: string) {
    return this.act(selector);
  }
  async download() {
    return { downloadId: "11111111-1111-1111-1111-111111111111", fileName: "a.pdf", byteSize: 1, mimeType: "application/pdf", sourceOrigin: "https://example.com" };
  }
  async upload(selector: string, downloadId: string) {
    return { ...identity, selector, downloadId, fileName: "a.pdf" };
  }
}

class Runtime implements BrowserRuntimePort {
  session = new FailingSession();
  opened = 0;
  async withSession<T>(_userId: string, run: (session: BrowserSessionPort) => Promise<T>): Promise<T> {
    this.opened += 1;
    return run(this.session);
  }
  async shutdown() {}
}

const SCOPE = {
  tenantId: "org-1",
  providerId: "browser",
  connector: "service",
  requesterRoles: ["owner", "admin"] as Array<"owner" | "admin">,
  approverRoles: ["owner", "admin"] as Array<"owner" | "admin">,
};
const access: BrowserWriteScopePort = { resolveWriteScope: async () => ({ ok: true, tenantScope: SCOPE }) };

let runtime: Runtime;
let journal: ExecutionJournalPort;
let approvals: IApprovalConsumptionPort;

beforeEach(() => {
  runtime = new Runtime();
  journal = new MemoryExecutionJournal();
  // As the approval store does: the approval is spent and the execution claimed together.
  const spent = new Set<string>();
  approvals = {
    async consumeForExecution(input) {
      if (spent.has(input.approvalId)) return { ok: false, reason: "already consumed" };
      const claimed = await journal.claimForExecution(input.executionId, { ownerId: "owner", leaseMs: 60_000 });
      if (!claimed) return { ok: false, reason: "execution not claimable" };
      spent.add(input.approvalId);
      return { ok: true };
    },
  };
});

/** What the executor hands a write it authorized (execution-grant.ts). */
function ctx(toolId: string, params: Record<string, unknown>, approvalId: string): ToolContext {
  const context: ToolContext = { userId: "user-1", traceId: "t", approvalId };
  issueExecutionGrant(context, { toolId, userId: "user-1", paramsHash: computeParamsHash(params), approvalId, sharedAccessChecked: true });
  return context;
}
const SUBMIT = { url: "https://example.com/form", selector: "#send", fields: { "#email": "a@example.com" } };
const CLICK = { url: "https://example.com/", selector: "#buy" };

async function journalStatus(params: Record<string, unknown>, toolId: string) {
  const record = await journal.begin({
    userId: "user-1",
    toolId,
    idempotencyKey: `${toolId}:${computeParamsHash(params)}`,
    paramsHash: computeParamsHash(params),
    provider: "browser",
  });
  return record.status;
}

describe("a failure after the action was sent is UNKNOWN, and is never sent again", () => {
  it.each([
    ["the session deadline", "Browser session exceeded its time limit"],
    ["a submit that navigated to a refused URL", "Action navigated to a refused URL: host resolves to a private address"],
  ])("%s", async (_label, message) => {
    runtime.session.actionError = new Error(message);
    const tool = new BrowserSubmitTool(runtime, journal, approvals, access);

    expect((await tool.execute(SUBMIT, ctx("browser.submit", SUBMIT, "approval-1"))).success).toBe(false);
    expect(await journalStatus(SUBMIT, "browser.submit")).toBe("UNKNOWN");

    // A person approves it again: nothing is sent, no browser is opened.
    runtime.session.actionError = null;
    const actionsBefore = runtime.session.actions;
    const openedBefore = runtime.opened;
    const retry = await tool.execute(SUBMIT, ctx("browser.submit", SUBMIT, "approval-2"));
    // Phase 19.5: the refusal says why (was "Execution already unknown").
    expect(retry).toMatchObject({ success: false, error: COMPUTER_CONTROL_ALREADY_UNKNOWN_MESSAGE });
    expect(runtime.session.actions).toBe(actionsBefore);
    expect(runtime.opened).toBe(openedBefore);
  });

  it("applies to a click too", async () => {
    runtime.session.actionError = new Error("Browser session exceeded its time limit");
    await new BrowserClickTool(runtime, journal, approvals, access).execute(CLICK, ctx("browser.click", CLICK, "approval-1"));
    expect(await journalStatus(CLICK, "browser.click")).toBe("UNKNOWN");
  });
});

describe("a failure before anything was sent stays FAILED, and may be tried again", () => {
  it("a missing element", async () => {
    runtime.session.actionError = new Error("Action failed: no such element");
    const tool = new BrowserSubmitTool(runtime, journal, approvals, access);
    expect((await tool.execute(SUBMIT, ctx("browser.submit", SUBMIT, "approval-1"))).success).toBe(false);
    expect(await journalStatus(SUBMIT, "browser.submit")).toBe("FAILED");

    runtime.session.actionError = null;
    const retry = await tool.execute(SUBMIT, ctx("browser.submit", SUBMIT, "approval-2"));
    expect(retry.success, retry.error).toBe(true);
  });

  it("a refused navigation never reaches the action", async () => {
    runtime.session.navigateError = new Error("Navigation refused: host resolves to a private address");
    const tool = new BrowserClickTool(runtime, journal, approvals, access);
    expect((await tool.execute(CLICK, ctx("browser.click", CLICK, "approval-1"))).success).toBe(false);
    expect(runtime.session.actions).toBe(0);
    expect(await journalStatus(CLICK, "browser.click")).toBe("FAILED");
  });

  it("stores the same failure text as before: the fixed fallback, never the browser's words", async () => {
    runtime.session.actionError = new Error("Browser session exceeded its time limit");
    await new BrowserSubmitTool(runtime, journal, approvals, access).execute(SUBMIT, ctx("browser.submit", SUBMIT, "approval-1"));
    const record = await journal.begin({
      userId: "user-1",
      toolId: "browser.submit",
      idempotencyKey: `browser.submit:${computeParamsHash(SUBMIT)}`,
      paramsHash: computeParamsHash(SUBMIT),
      provider: "browser",
    });
    expect(record.errorCode).toBe("AMBIGUOUS_OUTCOME");
    expect(record.errorMessage).toBe("Form submission failed");
  });
});

// ---------------------------------------------------------------------------
// Stage 19.2 audit (H2) — the remote browser service's failures.
//
// Over the network the browser's own words never reach the API: the service
// answers with a fixed code, and `@jarvis/browser-protocol` says on the error
// whether the request was sent and whether the action may have happened
// (`BrowserServiceError`: `outcome`, `phase`, `sideEffectPossible`). The
// journal reads those fields. Tools does not depend on the protocol package,
// so the error is built here in its exact shape.
// ---------------------------------------------------------------------------

type RemoteOutcome = "not-sent" | "no-effect" | "uncertain";

const REMOTE_SENTENCES: Record<string, string> = {
  TIMEOUT: "The browser service did not answer in time.",
  UNAVAILABLE: "The browser service is not available.",
  PROVIDER_ERROR: "The browser could not perform the action.",
  UNKNOWN_OUTCOME: "The outcome of the action is unknown; it was not retried.",
  SESSION_NOT_FOUND: "The session was not found.",
};

function remoteError(code: keyof typeof REMOTE_SENTENCES, outcome: RemoteOutcome): Error {
  const error = new Error(REMOTE_SENTENCES[code]) as Error & Record<string, unknown>;
  error.name = "BrowserServiceError";
  error.code = code;
  error.outcome = outcome;
  error.phase = outcome === "not-sent" ? "before-send" : "in-flight";
  error.sideEffectPossible = outcome === "uncertain";
  return error;
}

describe("a remote write that may have reached the site is UNKNOWN, and is never sent again", () => {
  it.each(["TIMEOUT", "UNAVAILABLE", "PROVIDER_ERROR", "UNKNOWN_OUTCOME"] as const)("%s", async (code) => {
    runtime.session.actionError = remoteError(code, "uncertain");
    const tool = new BrowserSubmitTool(runtime, journal, approvals, access);
    expect((await tool.execute(SUBMIT, ctx("browser.submit", SUBMIT, "approval-1"))).success).toBe(false);
    expect(await journalStatus(SUBMIT, "browser.submit")).toBe("UNKNOWN");

    // A new approval for the same submit: no browser is opened, nothing is sent.
    runtime.session.actionError = null;
    const actionsBefore = runtime.session.actions;
    const openedBefore = runtime.opened;
    const retry = await tool.execute(SUBMIT, ctx("browser.submit", SUBMIT, "approval-2"));
    // Phase 19.5: the refusal says why (was "Execution already unknown").
    expect(retry).toMatchObject({ success: false, error: COMPUTER_CONTROL_ALREADY_UNKNOWN_MESSAGE });
    expect(runtime.session.actions).toBe(actionsBefore);
    expect(runtime.opened).toBe(openedBefore);
  });

  it("records it as an ambiguous outcome, with the fixed fallback text", async () => {
    runtime.session.actionError = remoteError("TIMEOUT", "uncertain");
    await new BrowserClickTool(runtime, journal, approvals, access).execute(CLICK, ctx("browser.click", CLICK, "approval-1"));
    const record = await journal.begin({
      userId: "user-1",
      toolId: "browser.click",
      idempotencyKey: `browser.click:${computeParamsHash(CLICK)}`,
      paramsHash: computeParamsHash(CLICK),
      provider: "browser",
    });
    expect(record.status).toBe("UNKNOWN");
    expect(record.errorCode).toBe("AMBIGUOUS_OUTCOME");
  });
});

describe("a remote write known not to have acted stays FAILED, and may be tried again", () => {
  it.each([
    ["never sent", "UNAVAILABLE", "not-sent", "CANCELLED_BEFORE_SEND"],
    ["refused by the service before acting", "SESSION_NOT_FOUND", "no-effect", "REQUEST_CANCELLED"],
  ] as const)("%s", async (_label, code, outcome, errorCode) => {
    runtime.session.actionError = remoteError(code, outcome);
    const tool = new BrowserSubmitTool(runtime, journal, approvals, access);
    expect((await tool.execute(SUBMIT, ctx("browser.submit", SUBMIT, "approval-1"))).success).toBe(false);
    const record = await journal.begin({
      userId: "user-1",
      toolId: "browser.submit",
      idempotencyKey: `browser.submit:${computeParamsHash(SUBMIT)}`,
      paramsHash: computeParamsHash(SUBMIT),
      provider: "browser",
    });
    expect(record.status).toBe("FAILED");
    expect(record.errorCode).toBe(errorCode);

    runtime.session.actionError = null;
    const retry = await tool.execute(SUBMIT, ctx("browser.submit", SUBMIT, "approval-2"));
    expect(retry.success, retry.error).toBe(true);
  });

  it("a remote error that does not say what happened is UNKNOWN, never FAILED", async () => {
    const bare = new Error("The browser could not perform the action.");
    bare.name = "BrowserServiceError";
    runtime.session.actionError = bare;
    await new BrowserSubmitTool(runtime, journal, approvals, access).execute(SUBMIT, ctx("browser.submit", SUBMIT, "approval-1"));
    expect(await journalStatus(SUBMIT, "browser.submit")).toBe("UNKNOWN");
  });
});
