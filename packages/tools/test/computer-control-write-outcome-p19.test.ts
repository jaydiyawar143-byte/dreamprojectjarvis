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
import { computeParamsHash } from "@jarvis/core";
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
    expect(retry).toMatchObject({ success: false, error: "Execution already unknown" });
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
