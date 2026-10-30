// ---------------------------------------------------------------------------
// Phase 19, Stage 19.5 — what a person is told about an UNKNOWN browser write
// (S8, "UNKNOWN outcome handling").
//
// 19.1 and 19.2 record a write that may have reached the site as UNKNOWN and
// never send it again. What the tool then ANSWERS must say the same thing, in
// both modes: an in-process browser used to answer with its own error ("Action
// failed: Browser action aborted"), which reads as a failure a person may
// simply ask for again. Now an unknown outcome is always the one fixed
// sentence, with the outcome and the execution id beside it; a failure known
// to precede the action keeps its own message. And asking for the same action
// again is refused with a sentence that says why — nothing opened, nothing
// sent, the new approval not spent.
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
import {
  COMPUTER_CONTROL_ALREADY_UNKNOWN_MESSAGE,
  COMPUTER_CONTROL_OUTCOME_UNKNOWN_MESSAGE,
  computeParamsHash,
} from "@jarvis/core";
import { MemoryExecutionJournal } from "../src/execution-journal.js";
import { issueExecutionGrant } from "../src/execution-grant.js";
import { BrowserClickTool, BrowserSubmitTool, BrowserTypeTool } from "../src/tools/browser-tools.js";

const identity = { url: "https://example.com/", title: "Example", status: 200 };

class FailingSession implements BrowserSessionPort {
  actionError: Error | null = null;
  actions = 0;
  async navigate(url: string) {
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
    return { downloadId: "11111111-1111-4111-8111-111111111111", fileName: "a.pdf", byteSize: 1, mimeType: "application/pdf", sourceOrigin: "https://example.com" };
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
let spent: Set<string>;

beforeEach(() => {
  runtime = new Runtime();
  journal = new MemoryExecutionJournal();
  spent = new Set<string>();
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

function ctx(toolId: string, params: Record<string, unknown>, approvalId: string): ToolContext {
  const context: ToolContext = { userId: "user-1", traceId: "t", approvalId };
  issueExecutionGrant(context, { toolId, userId: "user-1", paramsHash: computeParamsHash(params), approvalId, sharedAccessChecked: true });
  return context;
}

const SUBMIT = { url: "https://example.com/form", selector: "#send", fields: { "#email": "a@example.com" } };
const TYPE = { url: "https://example.com/login", selector: "#password", text: "hunter2-TYPED" };
const CLICK = { url: "https://example.com/", selector: "#buy" };

/** The remote service's error, in its exact shape (Stage 19.2 audit, H2). */
function remoteUncertain(): Error {
  const error = new Error(COMPUTER_CONTROL_OUTCOME_UNKNOWN_MESSAGE) as Error & Record<string, unknown>;
  error.name = "BrowserServiceError";
  error.code = "UNKNOWN_OUTCOME";
  error.outcome = "uncertain";
  error.phase = "in-flight";
  error.sideEffectPossible = true;
  return error;
}

describe("Phase 19.5 — an UNKNOWN browser write says so, in both modes", () => {
  it.each([
    ["the in-process session's deadline", () => new Error("Browser session exceeded its time limit")],
    ["the executor's deadline aborting an in-process action", () => new Error("Action failed: Browser action aborted")],
    ["an in-process action that navigated somewhere refused", () => new Error("Action navigated to a refused URL: host resolves to a private address")],
    ["the separate service, unsure whether it acted", remoteUncertain],
  ])("%s", async (_label, makeError) => {
    runtime.session.actionError = makeError();
    const result = await new BrowserSubmitTool(runtime, journal, approvals, access).execute(SUBMIT, ctx("browser.submit", SUBMIT, "approval-1"));

    expect(result.success).toBe(false);
    expect(result.error).toBe(COMPUTER_CONTROL_OUTCOME_UNKNOWN_MESSAGE);
    expect(result.metadata).toMatchObject({ toolId: "browser.submit", outcome: "unknown" });
    expect(typeof result.metadata?.executionId).toBe("string");
    // The browser's own words are not the answer.
    expect(JSON.stringify(result)).not.toMatch(/time limit|aborted|refused URL|private address/);
    expect(runtime.session.actions).toBe(1);
  });

  it("a failure known to come before the action keeps its own message, and is not called unknown", async () => {
    runtime.session.actionError = new Error("Action failed: no such element");
    const result = await new BrowserClickTool(runtime, journal, approvals, access).execute(CLICK, ctx("browser.click", CLICK, "approval-1"));
    expect(result).toMatchObject({ success: false, error: "Action failed: no such element" });
    expect(result.metadata?.outcome).toBeUndefined();
  });

  it("never carries what was typed, in the answer or its metadata", async () => {
    runtime.session.actionError = new Error("Browser session exceeded its time limit");
    const result = await new BrowserTypeTool(runtime, journal, approvals, access).execute(TYPE, ctx("browser.type", TYPE, "approval-1"));
    expect(result.error).toBe(COMPUTER_CONTROL_OUTCOME_UNKNOWN_MESSAGE);
    expect(JSON.stringify(result)).not.toContain("hunter2-TYPED");
  });
});

describe("Phase 19.5 — the same action asked for again is refused, and says why", () => {
  it("opens nothing, sends nothing, and leaves the new approval unspent", async () => {
    runtime.session.actionError = new Error("Browser session exceeded its time limit");
    const tool = new BrowserSubmitTool(runtime, journal, approvals, access);
    await tool.execute(SUBMIT, ctx("browser.submit", SUBMIT, "approval-1"));

    runtime.session.actionError = null;
    const opened = runtime.opened;
    const actions = runtime.session.actions;
    const retry = await tool.execute(SUBMIT, ctx("browser.submit", SUBMIT, "approval-2"));

    expect(retry).toMatchObject({ success: false, error: COMPUTER_CONTROL_ALREADY_UNKNOWN_MESSAGE });
    expect(runtime.opened).toBe(opened);
    expect(runtime.session.actions).toBe(actions);
    expect(spent.has("approval-2")).toBe(false);
    // Still UNKNOWN: refusing the repeat decides nothing about the first.
    const record = await journal.begin({
      userId: "user-1",
      toolId: "browser.submit",
      idempotencyKey: `browser.submit:${computeParamsHash(SUBMIT)}`,
      paramsHash: computeParamsHash(SUBMIT),
      provider: "browser",
    });
    expect(record.status).toBe("UNKNOWN");
  });

  it("is no automatic retry: one approval, one attempt, however the attempt ended", async () => {
    runtime.session.actionError = remoteUncertain();
    await new BrowserClickTool(runtime, journal, approvals, access).execute(CLICK, ctx("browser.click", CLICK, "approval-1"));
    expect(runtime.session.actions).toBe(1);
    expect(runtime.opened).toBe(1);
  });
});
