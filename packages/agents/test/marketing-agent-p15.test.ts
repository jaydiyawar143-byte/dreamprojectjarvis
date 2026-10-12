// ---------------------------------------------------------------------------
// Phase 15 — the marketing agent: who may call what, where a marketing
// request is routed, and what the orchestrator lets a model do with it.
//
// Each orchestrator case scripts a model that DOES call the tool, so the
// gates — not the model's manners — are what is exercised.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import {
  MARKETING_PUBLISH_TOOL_IDS,
  MARKETING_READ_TOOL_IDS,
  MARKETING_RESEARCH_TOOL_IDS,
  MARKETING_TOOL_IDS,
  MARKETING_WORKSPACE_TOOL_IDS,
  type ITool,
} from "@jarvis/core";
import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import {
  AGENT_IDS,
  AGENT_POLICIES,
  META_READ_TOOLS,
  META_WRITE_TOOLS,
  isToolAllowed,
  schedulableToolIds,
} from "../src/agent-policy.js";
import { rankAgentCandidates } from "../src/agent-router.js";
import { classifyWriteIntent } from "../src/write-intent-gate.js";
import { detectWorkRequest } from "../src/work-request-detector.js";
import { MarketingAgent } from "../src/agents/marketing-agent.js";
import { MetaAdsAgent } from "../src/agents/meta-ads-agent.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";
import { PendingActionConflictError, PendingActionService } from "../src/pending-action-service.js";
import {
  FakePermissionChecker,
  RecordingAuditLogger,
  RecordingToolExecutor,
  ScriptedAIProvider,
  productionLikeTools,
  sessionFor,
  toolRegistryOf,
} from "./helpers/sprint6-harness.js";

const PUBLISH = MARKETING_TOOL_IDS.contentPublish;
const marketing = AGENT_POLICIES[AGENT_IDS.marketing]!;
const general = AGENT_POLICIES[AGENT_IDS.general]!;

const top = (message: string) => rankAgentCandidates(message)[0]!.agentId;
const order = (message: string) => rankAgentCandidates(message).map((c) => c.agentId);

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe("the marketing agent's allowlist", () => {
  it("holds the whole marketing workspace, publishing included", () => {
    for (const id of [...MARKETING_READ_TOOL_IDS, ...MARKETING_WORKSPACE_TOOL_IDS, ...MARKETING_RESEARCH_TOOL_IDS, ...MARKETING_PUBLISH_TOOL_IDS]) {
      expect(isToolAllowed(id, marketing.allowedTools), id).toBe(true);
    }
  });

  it("can read the ad account and cannot change it", () => {
    for (const id of META_READ_TOOLS) expect(marketing.allowedTools, id).toContain(id);
    for (const id of META_WRITE_TOOLS) expect(marketing.allowedTools, id).not.toContain(id);
  });

  it("holds nothing that messages, automates, browses interactively, forgets or reconfigures", () => {
    const forbidden = [
      "whatsapp.send",
      "n8n.trigger",
      "browser.click",
      "browser.submit",
      "browser.navigate",
      "memory.forget",
      "memory.forget_all",
      "memory.correct",
      "memory.list",
      "integration.connect",
      "integration.disconnect",
      "google.plan.gmail.sendDraft",
      "task.create",
    ];
    for (const id of forbidden) expect(marketing.allowedTools, id).not.toContain(id);
  });

  it("has a 'read' floor, so a viewer can ask what is going out this week", () => {
    expect(marketing.requiredPermissions).toEqual(["read"]);
    expect(marketing.writesRequireApproval).toBe(true);
    expect(marketing.domain).toBe("marketing");
  });

  it("every tool it is granted is one the build declares", () => {
    const real = new Set(productionLikeTools().map((t) => t.id));
    for (const id of marketing.allowedTools) expect(real.has(id), id).toBe(true);
  });
});

describe("publishing is held by one agent", () => {
  it("only the marketing agent may propose a publish", () => {
    const holders = Object.values(AGENT_POLICIES)
      .filter((p) => isToolAllowed(PUBLISH, p.allowedTools))
      .map((p) => p.agentId);
    expect(holders).toEqual([AGENT_IDS.marketing]);
  });

  it("the same holds for the publish check", () => {
    const holders = Object.values(AGENT_POLICIES)
      .filter((p) => p.allowedTools.includes(MARKETING_TOOL_IDS.publishPrepare))
      .map((p) => p.agentId);
    expect(holders).toEqual([AGENT_IDS.marketing]);
  });

  it("neither spelling of the tool name gets another agent past the allowlist", () => {
    for (const policy of Object.values(AGENT_POLICIES)) {
      if (policy.agentId === AGENT_IDS.marketing) continue;
      expect(isToolAllowed("marketing.content.publish", policy.allowedTools), policy.agentId).toBe(false);
      expect(isToolAllowed("marketing-content-publish", policy.allowedTools), policy.agentId).toBe(false);
    }
  });

  it("the general assistant holds the workspace without it", () => {
    for (const id of [...MARKETING_READ_TOOL_IDS, ...MARKETING_WORKSPACE_TOOL_IDS, ...MARKETING_RESEARCH_TOOL_IDS]) {
      expect(general.allowedTools, id).toContain(id);
    }
    for (const id of MARKETING_PUBLISH_TOOL_IDS) expect(general.allowedTools, id).not.toContain(id);
  });

  it("no other specialised agent holds any marketing tool", () => {
    for (const policy of Object.values(AGENT_POLICIES)) {
      if (policy.agentId === AGENT_IDS.marketing || policy.agentId === AGENT_IDS.general) continue;
      expect(policy.allowedTools.filter((id) => id.startsWith("marketing.")), policy.agentId).toEqual([]);
    }
  });

  it("a scheduled task may plan a marketing tool like any other — the approval gate still stops a publish from running unattended", () => {
    const schedulable = schedulableToolIds();
    expect(schedulable.has(MARKETING_TOOL_IDS.reportGenerate)).toBe(true);
    expect(schedulable.has(PUBLISH)).toBe(true);
    const publish = productionLikeTools().find((t) => t.id === PUBLISH)!;
    expect(publish.requiresApproval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe("routing a marketing request", () => {
  it.each([
    "Create a content calendar for the Diwali campaign",
    "Diwali campaign ke liye content calendar banao",
    "Plan my social media content for next week",
    "Write five Instagram captions for the launch",
    "Suggest hashtags for our festive sale",
    "What is on the content calendar this week?",
    "Set up a campaign workspace called Diwali Sale",
    "Do an SEO audit of my homepage",
    "Check the meta description of our pricing page",
    "Do keyword research for handmade soap",
    "What are my competitors saying on their homepage?",
    "Run a competitor analysis",
    "Generate a client report for last month",
    "Give me a performance report for October",
    "Create a monthly report for the client",
    "Publish the Diwali post to our Facebook page",
    "Mark the Diwali post as published, I posted it myself",
    "Give me marketing recommendations for this campaign",
  ])("%s", (message) => {
    expect(top(message)).toBe(AGENT_IDS.marketing);
  });

  it("an SEO audit of a linked page goes to marketing, not to the browser agent", () => {
    expect(order("Do an SEO audit of https://example.com/pricing").slice(0, 2)).toEqual([AGENT_IDS.marketing, AGENT_IDS.browser]);
    expect(top("Compare our competitor https://rival.example/ with https://mine.example/")).toBe(AGENT_IDS.marketing);
  });

  it("a link that merely contains a marketing word is still a request to open a page", () => {
    expect(top("Open https://example.com/blog/seo-tips and summarise it")).toBe(AGENT_IDS.browser);
    expect(top("Read https://example.com/competitors/list")).toBe(AGENT_IDS.browser);
    expect(order("Open https://example.com/blog/seo-tips and summarise it")).not.toContain(AGENT_IDS.marketing);
  });

  it("a system named outright still comes first, with marketing behind it", () => {
    const whatsapp = order("WhatsApp the content calendar to Priya");
    expect(whatsapp[0]).toBe(AGENT_IDS.communication);
    expect(whatsapp).toContain(AGENT_IDS.marketing);

    const n8n = order("Trigger the n8n workflow that posts our social media content");
    expect(n8n[0]).toBe(AGENT_IDS.automation);
    expect(n8n.indexOf(AGENT_IDS.marketing)).toBeGreaterThan(n8n.indexOf(AGENT_IDS.automation));
  });

  it("always ends with the general assistant", () => {
    expect(order("Create a content calendar").at(-1)).toBe(AGENT_IDS.general);
  });
});

describe("what routing left exactly where it was", () => {
  it.each<[string, string]>([
    ["Why did CPA rise this week?", AGENT_IDS.metaAds],
    ["Pause my Meta campaign", AGENT_IDS.metaAds],
    ["Mere Meta campaigns ke insights batao", AGENT_IDS.metaAds],
    ["Show my Google Ads campaigns", AGENT_IDS.googleAds],
    ["Show my Google Ads keywords", AGENT_IDS.googleAds],
    ["show my adwords spend", AGENT_IDS.googleAds],
    ["Balaghat mein best restaurants dikhao", AGENT_IDS.location],
    ["How far is Gondia?", AGENT_IDS.location],
    ["Send a WhatsApp message to Priya", AGENT_IDS.communication],
    ["Run my n8n workflow", AGENT_IDS.automation],
    ["Compare this week with last week", AGENT_IDS.analytics],
    ["What does my handbook say about refunds?", AGENT_IDS.knowledge],
    ["What is on my calendar today?", AGENT_IDS.general],
    ["Hello JARVIS", AGENT_IDS.general],
    ["Create a task to call the client", AGENT_IDS.general],
  ])("%s", (message, expected) => {
    expect(top(message)).toBe(expected);
  });

  it("a bare 'campaign', 'post' or 'report' is not a marketing-workspace signal", () => {
    for (const message of ["How is the campaign doing?", "Did the post go well?", "Send me the report"]) {
      expect(order(message), message).not.toContain(AGENT_IDS.marketing);
    }
  });
});

// ---------------------------------------------------------------------------
// The two detectors that run before a tool call
// ---------------------------------------------------------------------------

describe("the write-intent gate and the content calendar", () => {
  it.each([
    "Save these posts to the content calendar.",
    "Schedule the Diwali post for 20 October.",
    "Reschedule the launch post to Monday.",
    "Move the Diwali post to Friday.",
    "Mark the Diwali post as ready.",
    "Create a content calendar for the Diwali campaign.",
    "Add these three posts to the calendar.",
    "Publish the Diwali post to our Facebook page.",
    "Archive the old launch post.",
    "Diwali campaign ke liye content calendar banao",
    "Yeh posts calendar mein save karo",
    "Please save it to the calendar",
    "Great, now schedule that post for Friday",
  ])("is an instruction: %s", (message) => {
    expect(classifyWriteIntent(message).verdict).toBe("ACTION");
  });

  it.each<[string, string]>([
    ["Plan my social media content for next week", "INFO"],
    ["Suggest five post ideas for Diwali", "INFO"],
    ["Draft a caption for the launch post", "INFO"],
    ["What is on the content calendar this week?", "INFO"],
    ["How do I schedule a post?", "INFO"],
    ["The Diwali post is scheduled for Friday.", "INFO"],
    ["Our content calendar is full for October.", "INFO"],
    ["Schedule is tight for the campaign this week", "AMBIGUOUS"],
    ["Post-campaign analysis shows the budget held", "AMBIGUOUS"],
    ["Maybe save these posts to the calendar", "AMBIGUOUS"],
    ["Save", "AMBIGUOUS"],
  ])("is not an instruction: %s", (message, verdict) => {
    expect(classifyWriteIntent(message).verdict).toBe(verdict);
  });
});

describe("the work detector and the content calendar", () => {
  const now = new Date("2026-10-12T06:00:00.000Z");

  it.each([
    "Kal 10 baje ke liye Diwali post schedule karo",
    "Schedule the Diwali post for tomorrow at 10 am and check it",
    "Generate a content calendar for next week",
    "Check the content calendar for tomorrow at 9 am",
    "Yeh posts calendar mein save karo",
    "Reschedule the reel to Friday at 6 pm, then verify it",
  ])("putting content on the calendar is not work to run later: %s", (message) => {
    expect(detectWorkRequest(message, now)).toEqual({ type: "NONE" });
  });

  it("the time in such a sentence is the post's — no task is scheduled for it", () => {
    expect(detectWorkRequest("Kal 10 baje ke liye Diwali post schedule karo", now).type).not.toBe("SCHEDULE");
  });

  it("leaves real scheduled work exactly as it was", () => {
    expect(detectWorkRequest("Tomorrow at 10 am check my system status", now).type).toBe("SCHEDULE");
    expect(detectWorkRequest("check digitalonebox.com", now).type).toBe("EXECUTE");
    expect(detectWorkRequest("Schedule a meeting with Priya tomorrow", now)).toEqual({ type: "NONE" });
  });
});

// ---------------------------------------------------------------------------
// Through the orchestrator
// ---------------------------------------------------------------------------

/** The real risk table: READ_ONLY and LOW_IMPACT run, everything else needs approval. */
class RiskTableApprovalService {
  readonly checked: string[] = [];
  async checkPreExecution(tool: ITool) {
    this.checked.push(tool.id);
    if (tool.risk === "READ_ONLY" || tool.risk === "LOW_IMPACT") return { allowed: true, requiresApproval: false };
    return { allowed: false, requiresApproval: true, approvalId: `approval-${tool.id}`, reason: `Tool "${tool.id}" requires approval (risk: ${tool.risk})` };
  }
}

function pendingSpy() {
  const calls: Array<{ toolId: string; params: Record<string, unknown>; riskLevel: string }> = [];
  const service = {
    async createPendingAction(input: { conversationId: string; userId: string; toolId: string; action: string; params: Record<string, unknown>; riskLevel: string }) {
      calls.push({ toolId: input.toolId, params: input.params, riskLevel: input.riskLevel });
      return {
        pendingAction: {
          id: `pa-${calls.length}`,
          toolId: input.toolId,
          action: input.action,
          params: input.params,
          riskLevel: input.riskLevel,
          state: "WAITING_CONFIRMATION",
          approvalId: `ap-${calls.length}`,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          createdAt: new Date().toISOString(),
        },
        message: "Publish content item requires your confirmation.",
      };
    },
  };
  return { service, calls };
}

const PUBLISH_PARAMS = { contentId: "c1", targetId: "1234567890", targetName: "Shop Page", message: "Festive offer is live." };
const PLAN_PARAMS = { campaign: "Diwali Sale", items: [{ title: "Offer post", channel: "FACEBOOK", body: "Festive offer is live." }] };

describe("the marketing agent through the orchestrator", () => {
  let provider: ScriptedAIProvider;
  let audit: RecordingAuditLogger;
  let executor: RecordingToolExecutor;
  let registry: AgentRegistry;
  let tools: ReturnType<typeof toolRegistryOf>;
  let approval: RiskTableApprovalService;
  let pending: ReturnType<typeof pendingSpy>;

  beforeEach(() => {
    provider = new ScriptedAIProvider();
    audit = new RecordingAuditLogger();
    tools = toolRegistryOf(productionLikeTools());
    executor = new RecordingToolExecutor(tools);
    approval = new RiskTableApprovalService();
    pending = pendingSpy();
    registry = new AgentRegistry({ requirePolicy: true });
    registry.register(new ConversationalAssistant({ provider }));
    registry.register(new MarketingAgent({ provider }));
  });

  const orchestrator = () =>
    new Orchestrator(registry, executor, audit, {
      toolRegistry: tools,
      permissionChecker: new FakePermissionChecker(),
      toolApprovalService: approval,
      pendingActionService: pending.service,
    });

  const send = (message: string, role: "member" | "viewer" = "member", agentId?: string) =>
    orchestrator().process({ message, conversationId: "conv-mkt", stream: false, ...(agentId ? { agentId } : {}) }, sessionFor("user-1", role));

  it("routes a content-calendar request to the marketing agent", async () => {
    provider.pushToolCall(MARKETING_TOOL_IDS.contentList, {}, "c1");
    const res = await send("What is on the content calendar this week?");
    expect(res.success).toBe(true);
    expect(res.data?.agentId).toBe(AGENT_IDS.marketing);
    expect(executor.toolIds()).toEqual([MARKETING_TOOL_IDS.contentList]);
  });

  it("asked for a PLAN, a model that tries to save one is stopped: nothing is written", async () => {
    provider.pushToolCall(MARKETING_TOOL_IDS.contentPlan, PLAN_PARAMS, "c1");
    const res = await send("Plan my social media content for next week");
    expect(res.success).toBe(true);
    expect(executor.requests).toHaveLength(0);
    expect(pending.calls).toHaveLength(0);
    expect(audit.byAction("agent.tool_not_requested")).toHaveLength(1);
  });

  it("asked to SAVE it, the same call runs — with no approval, because nothing leaves JARVIS", async () => {
    provider.pushToolCall(MARKETING_TOOL_IDS.contentPlan, PLAN_PARAMS, "c1");
    const res = await send("Save these posts to the content calendar.");
    expect(res.success).toBe(true);
    expect(executor.toolIds()).toEqual([MARKETING_TOOL_IDS.contentPlan]);
    expect(executor.requests[0]!.params).toEqual(PLAN_PARAMS);
    expect(pending.calls).toHaveLength(0);
  });

  it("the save runs as the signed-in user, in the session's conversation, on behalf of the marketing agent", async () => {
    provider.pushToolCall(MARKETING_TOOL_IDS.contentPlan, PLAN_PARAMS, "c1");
    await send("Save these posts to the content calendar.");
    expect(executor.requests[0]).toMatchObject({ userId: "user-1", role: "member", conversationId: "conv-user-1", agentId: AGENT_IDS.marketing });
  });

  it("a statement about the calendar never becomes a write", async () => {
    provider.pushToolCall(MARKETING_TOOL_IDS.contentUpdate, { contentId: "c1", status: "READY" }, "c1");
    await send("The Diwali post is scheduled for Friday.");
    expect(executor.requests).toHaveLength(0);
    expect(audit.byAction("agent.tool_not_requested")).toHaveLength(1);
  });

  it("a report asked for as a question still runs: generating one is a read", async () => {
    provider.pushToolCall(MARKETING_TOOL_IDS.reportGenerate, {}, "c1");
    await send("Can I get a performance report for last month?");
    expect(executor.toolIds()).toEqual([MARKETING_TOOL_IDS.reportGenerate]);
  });

  it("asked to publish, the model's call becomes a pending action — it does not run", async () => {
    provider.pushToolCall(PUBLISH, PUBLISH_PARAMS, "c1");
    const res = await send("Publish the Diwali post to our Facebook page.");
    expect(res.success).toBe(true);
    expect(executor.requests).toHaveLength(0);
    expect(pending.calls).toEqual([{ toolId: PUBLISH, params: PUBLISH_PARAMS, riskLevel: "EXTERNAL_SIDE_EFFECT" }]);
  });

  it("a model that tries to publish when nobody asked is stopped before any approval is created", async () => {
    provider.pushToolCall(PUBLISH, PUBLISH_PARAMS, "c1");
    await send("What is on the content calendar this week?");
    expect(executor.requests).toHaveLength(0);
    expect(pending.calls).toHaveLength(0);
    expect(approval.checked).toHaveLength(0);
    expect(audit.byAction("agent.tool_not_requested")).toHaveLength(1);
  });

  it("a plan to publish is not an instruction to publish", async () => {
    provider.pushToolCall(PUBLISH, PUBLISH_PARAMS, "c1");
    await send("Plan what we should publish next week");
    expect(pending.calls).toHaveLength(0);
    expect(executor.requests).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // The caller's role, before a pending action exists.
  //
  // The pending-action branch used to ask nobody whether the role could run
  // the tool: a viewer was handed an approval to say "yes" to, and refused
  // only when they did. Nothing ran, but a request nobody could act on had
  // been put in front of a person.
  // -------------------------------------------------------------------------

  it("a viewer who asks to publish is refused before any pending action is created", async () => {
    provider.pushToolCall(PUBLISH, PUBLISH_PARAMS, "c1");
    const res = await send("Publish the Diwali post to our Facebook page.", "viewer");
    expect(res.success).toBe(true);
    expect(pending.calls).toHaveLength(0);
    expect(executor.requests).toHaveLength(0);
    expect(approval.checked).toHaveLength(0);
  });

  it("that refusal is audited, with the tool and the reason and none of the post", async () => {
    provider.pushToolCall(PUBLISH, PUBLISH_PARAMS, "c1");
    await send("Publish the Diwali post to our Facebook page.", "viewer");
    const denied = audit.byAction("agent.tool_role_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ userId: "user-1", toolId: PUBLISH, result: "rejected", agentId: AGENT_IDS.marketing });
    expect(denied[0]!.metadata).toMatchObject({ reason: "Missing permissions: read, write", risk: "EXTERNAL_SIDE_EFFECT" });
    expect(JSON.stringify(denied[0])).not.toContain("Festive offer");
  });

  it("the model is told why, in the words the approval service uses for the same refusal", async () => {
    provider.pushToolCall(PUBLISH, PUBLISH_PARAMS, "c1");
    await send("Publish the Diwali post to our Facebook page.", "viewer");
    const shown = provider.requests.at(-1)!.messages.map((m) => String(m.content ?? "")).join(" | ");
    expect(shown).toContain("Missing permissions: read, write");
  });

  it("a member who asks the same thing still gets the pending action", async () => {
    provider.pushToolCall(PUBLISH, PUBLISH_PARAMS, "c1");
    await send("Publish the Diwali post to our Facebook page.", "member");
    expect(pending.calls).toHaveLength(1);
    expect(audit.byAction("agent.tool_role_denied")).toHaveLength(0);
  });

  it("the same holds for any approval-gated tool, not only a publish", async () => {
    // The gate is the orchestrator's, not the marketing agent's: an ad-account
    // write proposed by the Meta Ads agent is refused for a viewer the same way.
    registry.register(new MetaAdsAgent({ provider }));
    const pause = { accountId: "act_1234567890", campaignId: "120210000000000001" };

    provider.pushToolCall("meta.campaign.pause", pause, "c1");
    await send("Pause the campaign 120210000000000001 now.", "viewer", AGENT_IDS.metaAds);
    expect(pending.calls).toHaveLength(0);
    expect(executor.requests).toHaveLength(0);
    expect(audit.byAction("agent.tool_role_denied").map((entry) => entry.toolId)).toEqual(["meta.campaign.pause"]);

    // And a member asking the same still gets the pending action.
    provider.pushToolCall("meta.campaign.pause", pause, "c2");
    await send("Pause the campaign 120210000000000001 now.", "member", AGENT_IDS.metaAds);
    expect(pending.calls.map((call) => call.toolId)).toEqual(["meta.campaign.pause"]);
  });

  it("with no permission checker wired the gate is skipped — the executor remains the one that refuses", async () => {
    provider.pushToolCall(PUBLISH, PUBLISH_PARAMS, "c1");
    const orch = new Orchestrator(registry, executor, audit, { toolRegistry: tools, toolApprovalService: approval, pendingActionService: pending.service });
    await orch.process({ message: "Publish the Diwali post to our Facebook page.", conversationId: "conv-mkt", stream: false }, sessionFor("user-1", "viewer"));
    expect(pending.calls).toHaveLength(1);
    expect(audit.byAction("agent.tool_role_denied")).toHaveLength(0);
  });

  it("with no pending-action flow, a publish still stops at the approval gate", async () => {
    provider.pushToolCall(PUBLISH, PUBLISH_PARAMS, "c1");
    const orch = new Orchestrator(registry, executor, audit, {
      toolRegistry: tools,
      permissionChecker: new FakePermissionChecker(),
      toolApprovalService: approval,
    });
    await orch.process({ message: "Publish the Diwali post to our Facebook page.", conversationId: "conv-mkt", stream: false }, sessionFor("user-1"));
    expect(executor.requests).toHaveLength(0);
    expect(approval.checked).toEqual([PUBLISH]);
  });

  it("with no gate at all wired, a publish is refused rather than run", async () => {
    provider.pushToolCall(PUBLISH, PUBLISH_PARAMS, "c1");
    const orch = new Orchestrator(registry, executor, audit, { toolRegistry: tools, permissionChecker: new FakePermissionChecker() });
    await orch.process({ message: "Publish the Diwali post to our Facebook page.", conversationId: "conv-mkt", stream: false }, sessionFor("user-1"));
    expect(executor.requests).toHaveLength(0);
    expect(audit.byAction("agent.approval_gate_missing")).toHaveLength(1);
  });

  it("the general assistant cannot publish even when a model asks it to", async () => {
    provider.pushToolCall(PUBLISH, PUBLISH_PARAMS, "c1");
    await send("Publish the Diwali post to our Facebook page.", "member", AGENT_IDS.general);
    expect(executor.requests).toHaveLength(0);
    expect(pending.calls).toHaveLength(0);
    const denied = audit.byAction("agent.tool_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ toolId: PUBLISH, agentId: AGENT_IDS.general });
  });

  it("the marketing agent cannot change an ad even when a model asks it to", async () => {
    provider.pushToolCall("meta.campaign.pause", { campaignId: "123" }, "c1");
    await send("Pause the worst campaign and publish the Diwali post");
    expect(executor.requests).toHaveLength(0);
    expect(pending.calls).toHaveLength(0);
    expect(audit.byAction("agent.tool_denied")).toHaveLength(1);
  });

  it("a viewer can read the calendar through the marketing agent", async () => {
    provider.pushToolCall(MARKETING_TOOL_IDS.contentList, {}, "c1");
    const res = await send("What is on the content calendar this week?", "viewer");
    expect(res.data?.agentId).toBe(AGENT_IDS.marketing);
    expect(executor.toolIds()).toEqual([MARKETING_TOOL_IDS.contentList]);
  });
});

// ---------------------------------------------------------------------------
// What the user is shown, and what may be changed, while a publish waits
// ---------------------------------------------------------------------------

describe("a publish waiting for confirmation", () => {
  function service() {
    const approvals = new Map<string, Record<string, unknown>>();
    let n = 0;
    const approvalRepo = {
      async create(data: Record<string, unknown>) {
        const approval = { ...data, id: `ap-${++n}`, status: "pending", createdAt: new Date().toISOString() };
        approvals.set(approval.id, approval);
        return approval as never;
      },
      async findById(id: string) {
        return (approvals.get(id) ?? null) as never;
      },
      async updateStatus() {
        return null as never;
      },
      async findPendingByConversationId(conversationId: string, userId: string) {
        const found = [...approvals.values()].reverse().find((a) => a.conversationId === conversationId && a.userId === userId && a.status === "pending");
        return (found ?? null) as never;
      },
      async updateParams() {
        return null as never;
      },
      async decideApproval(id: string, _userId: string, decision: "approve" | "reject") {
        const approval = approvals.get(id);
        if (!approval || approval.status !== "pending") return { outcome: "conflict" };
        approval.status = decision === "approve" ? "approved" : "rejected";
        return { outcome: decision === "approve" ? "approved" : "rejected" };
      },
    };
    const pendingService = new PendingActionService({ approvalRepo, toolRegistry: toolRegistryOf(productionLikeTools()) });
    return { pendingService, approvals };
  }

  const create = (svc: PendingActionService, params: Record<string, unknown> = PUBLISH_PARAMS) =>
    svc.createPendingAction({ conversationId: "conv-1", userId: "user-1", toolId: PUBLISH, action: PUBLISH, params, riskLevel: "EXTERNAL_SIDE_EFFECT" });

  it("shows the exact text and the place it will go, from the parameters the approval is bound to", async () => {
    const { pendingService } = service();
    const { message, pendingAction } = await create(pendingService, { ...PUBLISH_PARAMS, link: "https://shop.example/offer" });
    expect(message).toContain("Publish to: Shop Page");
    expect(message).toContain("Text to be posted:\nFestive offer is live.");
    expect(message).toContain("Link: https://shop.example/offer");
    expect(message).toContain("posted publicly");
    expect(pendingAction.params).toEqual({ ...PUBLISH_PARAMS, link: "https://shop.example/offer" });
  });

  it("offers yes or no — not a change of parameters", async () => {
    const { pendingService } = service();
    const { message } = await create(pendingService);
    expect(message).toContain("Reply 'yes' to publish it, or 'no' to cancel.");
    expect(message).not.toContain("updated parameters");
  });

  it("cannot be changed while it waits: the text and the place stay the ones that were shown", async () => {
    const { pendingService, approvals } = service();
    await create(pendingService);
    await expect(pendingService.modifyPendingAction("conv-1", "user-1", { message: "Something else entirely" })).rejects.toMatchObject({
      name: "PendingActionConflictError",
      reason: "NOT_MODIFIABLE",
    });
    await expect(pendingService.modifyPendingAction("conv-1", "user-1", { targetId: "9999999999" })).rejects.toBeInstanceOf(PendingActionConflictError);
    expect([...approvals.values()]).toHaveLength(1);
    expect([...approvals.values()][0]).toMatchObject({ status: "pending", params: PUBLISH_PARAMS });
  });

  it("can still be cancelled", async () => {
    const { pendingService, approvals } = service();
    await create(pendingService);
    expect((await pendingService.rejectPendingAction("conv-1", "user-1")).success).toBe(true);
    expect([...approvals.values()][0]!.status).toBe("rejected");
  });

  it("an ordinary write is still changeable, as before", async () => {
    const { pendingService } = service();
    await pendingService.createPendingAction({
      conversationId: "conv-2",
      userId: "user-1",
      toolId: "meta.campaign.budget.update",
      action: "meta.campaign.budget.update",
      params: { campaignId: "1", dailyBudget: 500 },
      riskLevel: "FINANCIAL",
    });
    const changed = await pendingService.modifyPendingAction("conv-2", "user-1", { dailyBudget: 700 });
    expect(changed.pendingAction.params).toEqual({ campaignId: "1", dailyBudget: 700 });
  });
});
