// ---------------------------------------------------------------------------
// Phase 18, Stage 18.5 — the trusted n8n node schemas, the agents side.
//
// The automation agent is told what the server can and cannot do. Stage 18.5
// changed what the server can do — it holds a pinned, reviewed copy of n8n's
// node parameter schemas and checks a draft's settings against it — so the
// prompt must not keep telling the model the opposite:
//
//   • a draft may be called validated only when every check ran and passed,
//     the configuration check against the pinned schemas among them;
//   • the prompt never claims JARVIS lacks n8n's schemas;
//   • the model is told to prefer the parameter names the server gives it, and
//     never to treat a name it invented as a parameter.
//
// Named `automation-library*` so CI's agents slice runs it.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { AutomationAgent } from "../src/agents/automation-agent.js";
import { ScriptedAIProvider } from "./helpers/sprint6-harness.js";

const prompt = () => new AutomationAgent({ provider: new ScriptedAIProvider([]) }).config.systemPrompt ?? "";

describe("the automation agent and the node schemas", () => {
  it("may call a draft validated only when every check ran and passed", () => {
    const text = prompt();
    expect(text).toContain("Never call a draft validated, deployed, live or active.");
    expect(text).toContain("A draft may be 'validated' only when every check ran and passed, including the configuration check against the pinned n8n node schemas");
    expect(text).toContain("its best status when unchecked is 'unverified'");
  });

  it("never claims JARVIS lacks n8n's node schemas", () => {
    const text = prompt();
    expect(text).not.toContain("which JARVIS does not have");
    expect(text).not.toContain("not validated against n8n's node schemas");
    expect(text).not.toMatch(/structure checked/);
  });

  it("is told to use the parameter names the server gives it", () => {
    const text = prompt();
    expect(text).toContain("A draft's view may carry schema hints");
    expect(text).toContain("Prefer those names for a setting's key");
    expect(text).toContain("a name the server did not give you is a question, not a parameter");
  });

  it("still refuses the things a draft may never hold", () => {
    const text = prompt();
    expect(text).toContain("Never put parameters, credentials, secrets, tokens, n8n expressions or URLs in it");
    expect(text).toContain("a credential is always 'configured in n8n'");
  });
});
