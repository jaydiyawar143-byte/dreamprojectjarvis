// ---------------------------------------------------------------------------
// Phase 18, Stage 18.2 — the orchestrator's half of "speech does not start a
// library sync", and the automation agent's library tools.
//
// A spoken turn (`SessionContext.inputMode: "voice"`, set by the chat route)
// that leads the model to `automation.library.sync` is answered here with the
// fixed sentence — the executor is never asked, so no tool runs and nothing is
// spent. The same request typed runs. The reads stay open to voice, and the
// mode travels to the executor on every request it does make, so the
// executor's own refusal (packages/tools) sees it too.
//
// Named `automation-library*`, the slice CI runs for this package.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATION_LIBRARY_TOOL_IDS, VOICE_REFUSED_TOOLS, VOICE_TOOL_REFUSED_CODE } from "@jarvis/core";
import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import { AGENT_IDS, AGENT_POLICIES } from "../src/agent-policy.js";
import { classifyWriteIntent } from "../src/write-intent-gate.js";
import { AutomationAgent } from "../src/agents/automation-agent.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";
import {
  FakePermissionChecker,
  RecordingAuditLogger,
  RecordingToolExecutor,
  ScriptedAIProvider,
  fakeTool,
  sessionFor,
  toolRegistryOf,
} from "./helpers/sprint6-harness.js";

const SYNC = AUTOMATION_LIBRARY_TOOL_IDS.sync;
const SEARCH = AUTOMATION_LIBRARY_TOOL_IDS.search;

/** Lets a LOW_IMPACT tool through, as the real ToolApprovalService does. */
const approvalByRisk = {
  checked: [] as string[],
  async checkPreExecution(tool: { id: string; risk: string }) {
    this.checked.push(tool.id);
    return tool.risk === "READ_ONLY" || tool.risk === "LOW_IMPACT"
      ? { allowed: true, requiresApproval: false }
      : { allowed: false, requiresApproval: true, approvalId: `approval-${tool.id}`, reason: "needs approval" };
  },
};

describe("the automation agent and the workflow library", () => {
  let provider: ScriptedAIProvider;
  let executor: RecordingToolExecutor;
  let audit: RecordingAuditLogger;
  let orchestrator: Orchestrator;
  const syncTool = fakeTool({ id: SYNC, risk: "LOW_IMPACT", requiredPermissions: ["read"] });
  const searchTool = fakeTool({ id: SEARCH, risk: "READ_ONLY" });

  beforeEach(() => {
    provider = new ScriptedAIProvider();
    audit = new RecordingAuditLogger();
    const tools = toolRegistryOf([fakeTool({ id: "n8n.trigger", risk: "EXTERNAL_SIDE_EFFECT", requiresApproval: true }), syncTool, searchTool]);
    executor = new RecordingToolExecutor(tools);
    const registry = new AgentRegistry({ requirePolicy: true });
    registry.register(new ConversationalAssistant({ provider }));
    registry.register(new AutomationAgent({ provider }));
    approvalByRisk.checked.length = 0;
    orchestrator = new Orchestrator(registry, executor, audit as never, {
      toolRegistry: tools,
      permissionChecker: new FakePermissionChecker(),
      toolApprovalService: approvalByRisk as never,
    });
  });

  const ask = (message: string, inputMode?: "voice" | "text") =>
    orchestrator.process(
      { message, conversationId: "conv-lib", agentId: AGENT_IDS.automation, stream: false },
      sessionFor("owner-1", "owner", inputMode ? { inputMode } : {})
    );

  it("grants the agent exactly the library tools, beside the trigger — never the allow-list change itself", () => {
    const allowed = AGENT_POLICIES[AGENT_IDS.automation]!.allowedTools;
    expect(allowed.filter((id) => id.startsWith("automation.library."))).toEqual([
      SEARCH,
      AUTOMATION_LIBRARY_TOOL_IDS.status,
      SYNC,
      AUTOMATION_LIBRARY_TOOL_IDS.inspect,
      AUTOMATION_LIBRARY_TOOL_IDS.propose,
    ]);
    for (const policy of Object.values(AGENT_POLICIES)) {
      expect(policy.allowedTools, policy.agentId).not.toContain(AUTOMATION_LIBRARY_TOOL_IDS.allowlistAdd);
    }
    expect(allowed).toContain("n8n.trigger");
    // No other agent holds them.
    for (const policy of Object.values(AGENT_POLICIES)) {
      if (policy.agentId === AGENT_IDS.automation) continue;
      expect(policy.allowedTools.some((id) => id.startsWith("automation.library.")), policy.agentId).toBe(false);
    }
  });

  it("reads 'sync the library' as an order, so a typed request is not refused as unrequested", () => {
    expect(classifyWriteIntent("Sync the n8n workflow library").verdict).toBe("ACTION");
    expect(classifyWriteIntent("Refresh the workflow catalog").verdict).toBe("ACTION");
    expect(classifyWriteIntent("n8n library sync karo").verdict).toBe("ACTION");
    expect(classifyWriteIntent("The library sync finished yesterday.").verdict).not.toBe("ACTION");
  });

  it("refuses a spoken sync before the executor is asked, in the fixed sentence", async () => {
    const execute = vi.spyOn(syncTool, "execute");
    provider.pushToolCall(SYNC, { continueUntilComplete: true }, "c1");
    const res = await ask("Sync the n8n workflow library until it is complete", "voice");
    expect(res.success).toBe(true);
    expect(executor.requests).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
    expect(approvalByRisk.checked).toEqual([]);
    const refused = audit.byAction("agent.tool_voice_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ toolId: SYNC, result: "rejected", metadata: { inputMode: "voice" } });
    // The model is handed the fixed sentence as the tool's result, as a refusal.
    const fed = JSON.stringify(provider.requests.at(-1)?.messages ?? []);
    expect(fed).toContain(VOICE_REFUSED_TOOLS[SYNC]!);
    expect(fed).toContain("PERMISSION_DENIED");
    expect(VOICE_TOOL_REFUSED_CODE).toBe("VOICE_NOT_ALLOWED");
  });

  it("refuses it under the model's sanitized spelling too", async () => {
    provider.pushToolCall("automation-library-sync", {}, "c1");
    await ask("Sync the n8n workflow library", "voice");
    expect(executor.requests).toHaveLength(0);
    expect(audit.byAction("agent.tool_voice_refused")).toHaveLength(1);
  });

  it("runs the same request typed, and says nothing about voice to the executor", async () => {
    provider.pushToolCall(SYNC, {}, "c1");
    await ask("Sync the n8n workflow library");
    expect(executor.toolIds()).toEqual([SYNC]);
    expect(executor.requests[0]!.inputMode).toBeUndefined();
    expect(audit.byAction("agent.tool_voice_refused")).toHaveLength(0);
  });

  it("lets voice read the library, and carries the mode to the executor", async () => {
    provider.pushToolCall(SEARCH, { search: "invoice" }, "c1");
    await ask("Which invoice workflows are in the library?", "voice");
    expect(executor.toolIds()).toEqual([SEARCH]);
    expect(executor.requests[0]!.inputMode).toBe("voice");
  });

  it("tells the model a library entry is not permission to run anything", async () => {
    provider.pushText("ok");
    await ask("What can you do with n8n?");
    const prompt = provider.lastSystemPrompt();
    expect(prompt).toContain("A library entry is NOT permission to run anything");
    expect(prompt).toContain("never be started or continued by voice");
    expect(prompt).toContain("never claim the library is complete until status says the last scan completed");
  });
});
