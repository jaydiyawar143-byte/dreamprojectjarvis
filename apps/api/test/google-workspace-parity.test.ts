// ---------------------------------------------------------------------------
// Phase 12 parity: the dashboard panel and the JARVIS tool are the same call.
//
// Proved the same way the integration parity test proves it — by instrumenting
// ONE service instance and asserting both arms arrive at it with the same
// action and the same params, differing only in the field that records where
// the request came from.
//
// Also pinned here: the tool layer must not flatten the envelope. A
// `needs_reauth` that reaches a model as "it failed" produces an assistant that
// suggests retrying a revoked grant, so each failure carries its own remedy
// through to the tool's error text.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GoogleTaskResult } from "@jarvis/core";
import { GOOGLE_TASK_ACTIONS } from "@jarvis/core";
import {
  createGoogleWorkspaceTools,
  GOOGLE_WORKSPACE_TOOL_IDS,
  type GoogleWorkspaceTaskPort,
} from "@jarvis/tools";
import { AGENT_POLICIES, GOOGLE_WORKSPACE_TOOLS, isToolAllowed, rankAgentCandidates } from "@jarvis/agents";

// ---------------------------------------------------------------------------

interface Call {
  action: string;
  params: Record<string, unknown> | undefined;
  source: string;
  userId: string;
}

/** One port, recording everything that reaches it. */
function harness(reply?: Partial<GoogleTaskResult<unknown>>) {
  const calls: Call[] = [];

  const port: GoogleWorkspaceTaskPort = {
    async executeTask(input, context) {
      calls.push({
        action: input.action,
        params: input.params,
        source: context.source,
        userId: context.userId,
      });
      return {
        success: true,
        source: "gmail",
        status: "ok",
        data: { messages: [] },
        message: "ok",
        ...reply,
      } as GoogleTaskResult<never>;
    },
  };

  const tools = createGoogleWorkspaceTools(port);
  const byId = new Map(tools.map((t) => [t.id, t]));

  /** What the REST route does: name the action, forward the params. */
  const fromFrontend = (action: string, params: Record<string, unknown>) =>
    port.executeTask({ action, params }, { userId: "u1", source: "jarvis" as const });

  return { calls, port, tools, byId, fromFrontend };
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------

describe("one service, two callers", () => {
  it("routes a panel read and a JARVIS read to the SAME instance", async () => {
    const h = harness();

    // The panel.
    await h.port.executeTask(
      { action: "gmail.listUnread", params: { limit: 15 } },
      { userId: "u1", source: "jarvis" }
    );

    // The sentence.
    await h.byId.get("gmail.listUnread")!.execute({ limit: 15 }, { userId: "u1" });

    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.action).toBe("gmail.listUnread");
    expect(h.calls[1]!.action).toBe("gmail.listUnread");
    expect(h.calls[0]!.userId).toBe(h.calls[1]!.userId);
  });

  it("covers every backend action with a JARVIS tool", () => {
    // An action reachable by a panel but not by a sentence would be a silent
    // asymmetry, which is the whole thing this architecture forbids.
    const h = harness();
    const toolIds = new Set(h.tools.map((t) => t.id));

    for (const action of GOOGLE_TASK_ACTIONS) {
      expect(toolIds.has(action), `no JARVIS tool for ${action}`).toBe(true);
    }
  });

  it("uses the action id as the tool id, so the two cannot drift", () => {
    expect([...GOOGLE_WORKSPACE_TOOL_IDS].sort()).toEqual([...GOOGLE_TASK_ACTIONS].sort());
  });

  it("forwards the same params from both arms", async () => {
    const h = harness();

    await h.port.executeTask(
      { action: "gmail.search", params: { query: "from:priya", limit: 10 } },
      { userId: "u1", source: "jarvis" }
    );
    await h.byId.get("gmail.search")!.execute({ query: "from:priya", limit: 10 }, { userId: "u1" });

    expect(h.calls[0]!.params).toMatchObject({ query: "from:priya", limit: 10 });
    expect(h.calls[1]!.params).toMatchObject({ query: "from:priya", limit: 10 });
  });
});

// ---------------------------------------------------------------------------

describe("an actionable state is an ANSWER, not a retrieval failure", () => {
  // Caught on a live run: "meri unread Gmail emails summarize karo" with no
  // Google connected returned a FAILED ToolResult, which tripped the
  // Orchestrator's all-tools-failed guard, and the user got "Data retrieval
  // failed" instead of "connect your Google account". The three states only a
  // human can resolve must therefore come back as a successful lookup carrying
  // bad news.
  const ACTIONABLE = ["not_connected", "needs_reauth", "permission_missing"] as const;

  for (const status of ACTIONABLE) {
    it(`reports ${status} as a successful lookup carrying the remedy`, async () => {
      const h = harness({
        success: false,
        status,
        data: null,
        message: `Problem: ${status}.`,
        requiredAction: "Connect your Google account, then try again.",
      });

      const result = await h.byId.get("gmail.listUnread")!.execute({}, { userId: "u1" });

      // Success, so the orchestrator's guard does not fire.
      expect(result.success).toBe(true);
      // But it plainly says nothing is available.
      expect((result.data as { available: boolean }).available).toBe(false);
      expect((result.data as { status: string }).status).toBe(status);
      expect((result.data as { requiredAction: string }).requiredAction).toMatch(/connect/i);
      // And the model is told what to do with it.
      expect((result.metadata as { rule?: string }).rule).toMatch(/do NOT retry/i);
    });
  }

  it("still FAILS on a genuine provider error, where a retry is right", async () => {
    const h = harness({
      success: false,
      status: "provider_error",
      data: null,
      message: "Google did not respond within 12s.",
    });

    const result = await h.byId.get("gmail.listUnread")!.execute({}, { userId: "u1" });

    // A retry genuinely might work here, so the guard firing is correct.
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/did not respond/i);
  });

  it("never reports unavailable data as though it were retrieved", async () => {
    const h = harness({
      success: false,
      status: "not_connected",
      data: null,
      message: "No Google account is connected.",
      requiredAction: "Connect your Google account.",
    });

    const result = await h.byId.get("gmail.listUnread")!.execute({}, { userId: "u1" });

    // The critical thing: no message list, empty or otherwise, that a model
    // could present as "here is your inbox".
    expect(result.data).not.toHaveProperty("messages");
    expect((result.data as { available: boolean }).available).toBe(false);
  });
});

describe("the tool layer does not flatten the envelope", () => {
  it("carries the needs_reauth remedy through to the model", async () => {
    const h = harness({
      success: false,
      status: "needs_reauth",
      data: null,
      message: "Google rejected the stored authorization.",
      requiredAction: "Reconnect your Google account to authorize again.",
    });

    const result = await h.byId.get("gmail.listUnread")!.execute({}, { userId: "u1" });

    // Both halves reach the model: what happened, and what to do.
    const message = (result.metadata as { message?: string }).message ?? "";
    expect(message).toContain("rejected the stored authorization");
    expect(message).toContain("Reconnect your Google account");
  });

  it("names the specific service on permission_missing", async () => {
    const h = harness({
      success: false,
      status: "permission_missing",
      data: null,
      message: "Your Google connection does not include Calendar access.",
      requiredAction: "Reconnect Google and include Calendar when asked, to grant read access.",
    });

    const result = await h.byId
      .get("calendar.listUpcomingEvents")!
      .execute({}, { userId: "u1" });

    const message = (result.metadata as { message?: string }).message ?? "";
    expect(message).toContain("does not include Calendar");
    expect(message).toContain("include Calendar when asked");
  });

  it("reports the status in metadata on success, so a caller can branch", async () => {
    const h = harness();
    const result = await h.byId.get("gmail.listUnread")!.execute({}, { userId: "u1" });

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({ status: "ok", source: "gmail" });
  });
});

// ---------------------------------------------------------------------------

describe("argument validation happens before the service is called", () => {
  it("asks for a search query rather than sending an empty one", async () => {
    const h = harness();
    const result = await h.byId.get("gmail.search")!.execute({}, { userId: "u1" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/what should i search/i);
    // Nothing reached the service.
    expect(h.calls).toHaveLength(0);
  });

  it("asks for a message id rather than guessing one", async () => {
    const h = harness();
    const result = await h.byId.get("gmail.getMessage")!.execute({}, { userId: "u1" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/message id/i);
    expect(h.calls).toHaveLength(0);
  });

  it("asks for a file id rather than guessing one", async () => {
    const h = harness();
    const result = await h.byId.get("drive.getFileMetadata")!.execute({}, { userId: "u1" });

    expect(result.success).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it("asks for an event id rather than guessing one", async () => {
    const h = harness();
    const result = await h.byId.get("calendar.getEvent")!.execute({}, { userId: "u1" });

    expect(result.success).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it("does not require a query for the list actions", async () => {
    const h = harness();

    await h.byId.get("gmail.listUnread")!.execute({}, { userId: "u1" });
    await h.byId.get("drive.listRecentFiles")!.execute({}, { userId: "u1" });
    await h.byId.get("calendar.listUpcomingEvents")!.execute({}, { userId: "u1" });

    expect(h.calls).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------

describe("every tool is read-only", () => {
  it("declares READ_ONLY risk and no approval", () => {
    const h = harness();
    for (const tool of h.tools) {
      expect(tool.risk, tool.id).toBe("READ_ONLY");
      // Reading your own mail needs no second person's consent, and requiring
      // one would make the feature unusable without making it safer.
      expect(tool.requiresApproval, tool.id).toBe(false);
      expect(tool.requiredPermissions, tool.id).toEqual(["read"]);
    }
  });

  it("exposes no tool whose name suggests a write", () => {
    const h = harness();
    for (const tool of h.tools) {
      expect(tool.id).not.toMatch(/send|delete|create|update|modify|trash|archive/i);
    }
  });
});

// ---------------------------------------------------------------------------

describe("routing and policy", () => {
  const MESSAGES = [
    "meri unread Gmail emails summarize karo",
    "latest unread emails dikhao",
    "Drive mein presentation dhoondo",
    "Drive ki recent files dikhao",
    "kal ka calendar dikhao",
    "meri next meetings batao",
  ];

  it("routes every reported message to an agent that holds the Workspace tools", () => {
    for (const message of MESSAGES) {
      const agentId = rankAgentCandidates(message)[0]!.agentId;
      const policy = AGENT_POLICIES[agentId];
      expect(policy, `${message} -> ${agentId}`).toBeDefined();

      // At least the listing tools must be reachable from wherever it lands.
      const reachable = GOOGLE_WORKSPACE_TOOLS.some((t) =>
        isToolAllowed(t, policy!.allowedTools)
      );
      expect(reachable, `${message} -> ${agentId} cannot reach Workspace tools`).toBe(true);
    }
  });

  it("grants Workspace reads to the general assistant", () => {
    // Where "meri unread emails dikhao" lands: it matches no domain signal.
    const general = AGENT_POLICIES["conversational-assistant"]!;
    for (const tool of GOOGLE_WORKSPACE_TOOLS) {
      expect(isToolAllowed(tool, general.allowedTools), tool).toBe(true);
    }
  });

  it("does NOT grant mail access to unrelated agents", () => {
    // No Meta, WhatsApp, n8n or browser agent has business reading the user's
    // mail, and least privilege here is real rather than decorative.
    for (const agentId of [
      "meta-ads-agent",
      "communication-agent",
      "automation-agent",
      "browser-agent",
    ]) {
      const policy = AGENT_POLICIES[agentId];
      if (!policy) continue;
      for (const tool of GOOGLE_WORKSPACE_TOOLS) {
        expect(isToolAllowed(tool, policy.allowedTools), `${agentId} -> ${tool}`).toBe(false);
      }
    }
  });
});
