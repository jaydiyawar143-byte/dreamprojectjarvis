// ---------------------------------------------------------------------------
// Phase 18, Stage 18.4 — the automation agent and workflow planning, on the
// agents side. Named `automation-library*` so CI's agents slice runs it.
//
//   • only the automation agent holds the planning tools — match, and the
//     four draft tools — and never the allow-list change;
//   • none of them is on the voice list: speech may ask for a match or a
//     draft (a proposal), as AGENTS.md allows; nothing here can confirm;
//   • a request for a plan is not an instruction to save one: the write-intent
//     gate reads "draft a workflow…" as planning, so the draft tools (LOW_IMPACT)
//     do not run, while "create a draft…" or "save it as a draft" do;
//   • the prompt says match first, never guess an app, never put a secret or
//     a parameter in a draft, and never call one validated or deployed.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { AUTOMATION_LIBRARY_TOOL_IDS, AUTOMATION_PLANNING_TOOL_IDS, VOICE_REFUSED_TOOLS } from "@jarvis/core";
import { AGENT_IDS, AGENT_POLICIES } from "../src/agent-policy.js";
import { classifyWriteIntent } from "../src/write-intent-gate.js";
import { AutomationAgent } from "../src/agents/automation-agent.js";
import { ScriptedAIProvider } from "./helpers/sprint6-harness.js";

const PLANNING = Object.values(AUTOMATION_PLANNING_TOOL_IDS);

describe("the planning tools on the agents side", () => {
  it("are granted to the automation agent alone, beside — never instead of — the allow-list boundary", () => {
    const holders = Object.entries(AGENT_POLICIES)
      .filter(([, policy]) => PLANNING.some((id) => policy.allowedTools.includes(id)))
      .map(([agent]) => agent);
    expect(holders).toEqual([AGENT_IDS.automation]);
    expect(AGENT_POLICIES[AGENT_IDS.automation]!.allowedTools).toEqual(expect.arrayContaining(PLANNING));
    expect(Object.values(AGENT_POLICIES).some((p) => p.allowedTools.includes(AUTOMATION_LIBRARY_TOOL_IDS.allowlistAdd))).toBe(false);
  });

  it("may be asked for by voice — a match or a draft is a proposal, and none of them confirms anything", () => {
    for (const id of PLANNING) expect(VOICE_REFUSED_TOOLS[id], id).toBeUndefined();
  });

  it("save a draft only on an instruction: a request for a plan is answered, not stored", () => {
    for (const planning of [
      "Draft a workflow that posts new form leads to Slack",
      "Plan an automation for our invoices",
      "Propose a workflow that emails the weekly report",
    ]) {
      expect(classifyWriteIntent(planning), planning).toEqual({ verdict: "INFO", reason: "planning" });
    }
    for (const instruction of [
      "Create a draft workflow that posts new form leads to Slack",
      "Save it as a draft",
      "Please save that workflow draft",
    ]) {
      expect(classifyWriteIntent(instruction).verdict, instruction).toBe("ACTION");
    }
  });

  it("are explained to the model with the limits the server enforces", () => {
    const prompt = new AutomationAgent({ provider: new ScriptedAIProvider([]) }).config.systemPrompt ?? "";
    expect(prompt).toContain("call automation.workflow.match FIRST");
    expect(prompt).toContain("Never guess an app or a trigger.");
    expect(prompt).toContain("Never put parameters, credentials, secrets, tokens, n8n expressions or URLs in it");
    expect(prompt).toContain("Never call a draft validated, deployed, live or active.");
    expect(prompt).toContain("set overrideReuse only if they still want a new one");
  });
});
