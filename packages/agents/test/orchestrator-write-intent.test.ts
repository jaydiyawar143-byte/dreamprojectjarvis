// ---------------------------------------------------------------------------
// Write-intent gate at the orchestrator — BUG-INTENT-001 / BUG-SAFETY-001.
//
// Each case scripts a model that DOES call a write tool, so the gate — not
// the model's good manners — is what the test exercises. Three layers are
// asserted together for every unrequested-write case:
//
//   1. write tool call  = 0   (executor.requests stays empty)
//   2. createPendingAction = 0 (the pending-action spy stays empty)
//   3. approval check/row = 0 (the approval service is never consulted)
//
// and the ACTION cases prove the existing approval flow still runs: the gate
// narrows WHICH messages reach the approval boundary, it does not weaken it.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import { AGENT_IDS } from "../src/agent-policy.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";
import {
  FakePermissionChecker,
  GatingApprovalService,
  RecordingAuditLogger,
  RecordingToolExecutor,
  ScriptedAIProvider,
  productionLikeTools,
  sessionFor,
  toolRegistryOf,
} from "./helpers/sprint6-harness.js";

const WRITE_TOOL = "meta.campaign.budget.update";

/** Layer 2 spy: every createPendingAction call the orchestrator makes. */
function createPendingActionSpy() {
  const calls: Array<{ toolId: string; params: Record<string, unknown> }> = [];
  const service = {
    async createPendingAction(input: {
      conversationId: string;
      userId: string;
      toolId: string;
      action: string;
      params: Record<string, unknown>;
      riskLevel: string;
    }) {
      calls.push({ toolId: input.toolId, params: input.params });
      return {
        pendingAction: {
          id: `pa-${calls.length}`,
          toolId: input.toolId,
          action: input.action,
          params: input.params,
          riskLevel: input.riskLevel,
          state: "WAITING_CONFIRMATION",
          approvalId: `ap-${calls.length}`,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          createdAt: new Date().toISOString(),
          summary: "Approval requested",
        },
        message: "Approval requested. Confirm to proceed.",
      };
    },
  };
  return { service, calls };
}

describe("write-intent gate in the orchestrator", () => {
  let provider: ScriptedAIProvider;
  let audit: RecordingAuditLogger;
  let executor: RecordingToolExecutor;
  let registry: AgentRegistry;
  let tools: ReturnType<typeof toolRegistryOf>;
  let approval: GatingApprovalService;
  let pending: ReturnType<typeof createPendingActionSpy>;

  beforeEach(() => {
    provider = new ScriptedAIProvider();
    audit = new RecordingAuditLogger();
    tools = toolRegistryOf(productionLikeTools());
    executor = new RecordingToolExecutor(tools);
    approval = new GatingApprovalService();
    pending = createPendingActionSpy();
    registry = new AgentRegistry({ requirePolicy: true });
    registry.register(new ConversationalAssistant({ provider }));
  });

  function orchestrator(overrides: Record<string, unknown> = {}) {
    return new Orchestrator(registry, executor, audit, {
      toolRegistry: tools,
      permissionChecker: new FakePermissionChecker(),
      toolApprovalService: approval,
      pendingActionService: pending.service,
      ...overrides,
    });
  }

  /** The model attempts the write once; round 2 falls back to plain text. */
  function scriptWriteAttempt(id = "c1") {
    provider.pushToolCall(WRITE_TOOL, { campaignId: "c_1", amount: 50000 }, id);
  }

  async function send(message: string, orch = orchestrator()) {
    return orch.process(
      { message, conversationId: "conv-wig", agentId: AGENT_IDS.general },
      sessionFor("user-1")
    );
  }

  /** Three-layer assertion: no execution, no pending action, no approval. */
  function expectNothingWrote() {
    expect(executor.requests).toHaveLength(0);
    expect(pending.calls).toHaveLength(0);
    expect(approval.checked).toHaveLength(0);
  }

  // -------------------------------------------------------------------------
  // Negative cases — the write must not happen on any of these.
  // -------------------------------------------------------------------------

  it("A: 'My project budget is ₹50,000.' does not write", async () => {
    scriptWriteAttempt();

    const res = await send("My project budget is ₹50,000.");

    expect(res.success).toBe(true);
    expectNothingWrote();
    expect(audit.byAction("agent.tool_not_requested")).toHaveLength(1);
  });

  it("B: 'The campaign budget should be ₹50,000.' does not write and asks instead", async () => {
    scriptWriteAttempt();

    const res = await send("The campaign budget should be ₹50,000.");

    expect(res.success).toBe(true);
    expectNothingWrote();
    expect(audit.byAction("agent.tool_clarification_required")).toHaveLength(1);
  });

  it("C: 'Prepare a campaign with a ₹50,000 daily budget.' routes to planning, does not write", async () => {
    provider.pushToolCall("meta.campaign.create", { accountId: "act_1", proposal: { name: "Plan" } }, "c1");

    const res = await send("Prepare a campaign with a ₹50,000 daily budget.");

    expect(res.success).toBe(true);
    expect(executor.requests).toHaveLength(0);
    expect(pending.calls).toHaveLength(0);
    expect(approval.checked).toHaveLength(0);
    expect(audit.byAction("agent.tool_not_requested")).toHaveLength(1);
  });

  it("F: '…budget is ₹50,000. What should I plan?' does not write", async () => {
    provider.pushToolCall("meta.campaign.create", { accountId: "act_1", proposal: { name: "Plan" } }, "c1");

    const res = await send(
      "My test project's monthly marketing budget is ₹50,000. What should I plan?"
    );

    expect(res.success).toBe(true);
    expect(executor.requests).toHaveLength(0);
    expect(pending.calls).toHaveLength(0);
    expect(approval.checked).toHaveLength(0);
  });

  it("H: 'My Meta campaign has a monthly budget of ₹50,000.' does not write", async () => {
    scriptWriteAttempt();

    const res = await send("My Meta campaign has a monthly budget of ₹50,000.");

    expect(res.success).toBe(true);
    expectNothingWrote();
  });

  it("G: first turn INFO (no write), second turn ACTION (approval requested)", async () => {
    // Turn 1 — a statement of context. The model still tries the write.
    scriptWriteAttempt("c1");
    const first = await send("My project budget is ₹50,000.");
    expect(first.success).toBe(true);
    expectNothingWrote();

    // Turn 2 — a real command. The existing approval flow must run.
    provider.pushToolCall(WRITE_TOOL, { campaignId: "c_1", amount: 10000 }, "c2");
    const second = await send("Set the Meta campaign daily budget to ₹10,000.");

    expect(second.success).toBe(true);
    expect(executor.requests).toHaveLength(0);
    expect(pending.calls).toHaveLength(1);
    expect(pending.calls[0]!.toolId).toBe(WRITE_TOOL);
  });

  // -------------------------------------------------------------------------
  // Positive cases — ACTION still reaches the approval boundary unchanged.
  // -------------------------------------------------------------------------

  it("D: 'Change the campaign daily budget to ₹50,000.' creates the pending action", async () => {
    scriptWriteAttempt();

    const res = await send("Change the campaign daily budget to ₹50,000.");

    expect(res.success).toBe(true);
    expect(executor.requests).toHaveLength(0);
    expect(pending.calls).toHaveLength(1);
    expect(pending.calls[0]!.toolId).toBe(WRITE_TOOL);
    expect(audit.byAction("agent.tool_not_requested")).toHaveLength(0);
    expect(audit.byAction("agent.tool_clarification_required")).toHaveLength(0);
  });

  it("E: '…and execute it.' still requires approval (pending action created, nothing executed)", async () => {
    scriptWriteAttempt();

    const res = await send("Change the campaign daily budget to ₹50,000 and execute it.");

    expect(res.success).toBe(true);
    expect(executor.requests).toHaveLength(0);
    expect(pending.calls).toHaveLength(1);
  });

  it("E: without a pending-action flow, the approval service still gates an ACTION write", async () => {
    scriptWriteAttempt();

    const res = await send(
      "Change the campaign daily budget to ₹50,000.",
      orchestrator({ pendingActionService: null })
    );

    expect(res.success).toBe(true);
    expect(approval.checked).toContain(WRITE_TOOL);
    expect(executor.requests).toHaveLength(0);
    expect(audit.byAction("agent.tool_not_requested")).toHaveLength(0);
  });

  it("a true ACTION write executes when nothing gates it (the gate is not a write ban)", async () => {
    const bareRegistry = new AgentRegistry();
    bareRegistry.register(new ConversationalAssistant({ provider }));
    scriptWriteAttempt();

    const res = await new Orchestrator(bareRegistry, executor, audit, {
      toolRegistry: tools,
      permissionChecker: new FakePermissionChecker(),
    }).process(
      { message: "Change the campaign daily budget to ₹50,000.", conversationId: "conv-wig", agentId: AGENT_IDS.general },
      sessionFor("user-1")
    );

    expect(res.success).toBe(true);
    expect(executor.toolIds()).toContain(WRITE_TOOL);
    expect(pending.calls).toHaveLength(0);
  });

  it("READ_ONLY tools are never gated, even on an informational turn", async () => {
    provider
      .pushToolCall("meta.campaigns", { accountId: "act_1" }, "c1")
      .pushText("Here are your campaigns.");

    const res = await send("My project budget is ₹50,000.");

    expect(res.success).toBe(true);
    expect(executor.toolIds()).toContain("meta.campaigns");
    expect(pending.calls).toHaveLength(0);
  });
});