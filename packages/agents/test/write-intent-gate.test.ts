// ---------------------------------------------------------------------------
// Write-intent gate — classifier unit tests.
//
// Pins the verdicts that matter, including every real message observed in the
// bug report and every message the existing orchestrator suites send through
// write tools. The gate must never regress those.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { classifyWriteIntent } from "../src/write-intent-gate.js";

describe("classifyWriteIntent", () => {
  // -------------------------------------------------------------------------
  // The bug: a statement of context must never authorize a write.
  // -------------------------------------------------------------------------
  it("A: reads a project budget statement as INFO (declarative)", () => {
    expect(classifyWriteIntent("My project budget is ₹50,000.")).toEqual({
      verdict: "INFO",
      reason: "declarative",
    });
  });

  it("H: reads a Meta campaign budget statement as INFO (declarative)", () => {
    expect(classifyWriteIntent("My Meta campaign has a monthly budget of ₹50,000.")).toEqual({
      verdict: "INFO",
      reason: "declarative",
    });
  });

  it("B: reads a hedged 'should be' as AMBIGUOUS, never ACTION", () => {
    const verdict = classifyWriteIntent("The campaign budget should be ₹50,000.");
    expect(verdict.verdict).toBe("AMBIGUOUS");
  });

  it("F: routes a planning question to INFO (planning)", () => {
    expect(
      classifyWriteIntent("My test project's monthly marketing budget is ₹50,000. What should I plan?")
    ).toEqual({ verdict: "INFO", reason: "planning" });
  });

  it("a bare preference statement stays INFO", () => {
    expect(classifyWriteIntent("I prefer concise reports.")).toEqual({
      verdict: "INFO",
      reason: "declarative",
    });
  });

  it("an empty message is INFO (irrelevant)", () => {
    expect(classifyWriteIntent("   ")).toEqual({ verdict: "INFO", reason: "irrelevant" });
  });

  it("a greeting is INFO (irrelevant)", () => {
    expect(classifyWriteIntent("Hello JARVIS")).toEqual({ verdict: "INFO", reason: "irrelevant" });
  });

  // -------------------------------------------------------------------------
  // Real instructions that MUST still authorize the write.
  // -------------------------------------------------------------------------
  it("D: an explicit budget change is ACTION", () => {
    expect(classifyWriteIntent("Change the campaign daily budget to ₹50,000.")).toEqual({
      verdict: "ACTION",
    });
  });

  it("E: an explicit change plus execute keeps ACTION", () => {
    expect(classifyWriteIntent("Change the campaign daily budget to ₹50,000 and execute it.")).toEqual({
      verdict: "ACTION",
    });
  });

  it("G2: an explicit set keeps ACTION", () => {
    expect(classifyWriteIntent("Set the Meta campaign daily budget to ₹10,000.")).toEqual({
      verdict: "ACTION",
    });
  });

  it("approval-flow message 'Create a campaign named Test' stays ACTION", () => {
    expect(classifyWriteIntent("Create a campaign named Test")).toEqual({ verdict: "ACTION" });
  });

  it("meta-ads message 'Pause this ad set.' stays ACTION", () => {
    expect(classifyWriteIntent("Pause this ad set.")).toEqual({ verdict: "ACTION" });
  });

  it("meta-ads message 'Pause adset as_77' stays ACTION", () => {
    expect(classifyWriteIntent("Pause adset as_77")).toEqual({ verdict: "ACTION" });
  });

  it("multi-round message 'look, then pause it' stays ACTION", () => {
    expect(classifyWriteIntent("look, then pause it")).toEqual({ verdict: "ACTION" });
  });

  it("a prepositional-target imperative stays ACTION", () => {
    expect(classifyWriteIntent("Deploy to prod")).toEqual({ verdict: "ACTION" });
  });

  it("a Hinglish imperative stays ACTION", () => {
    expect(classifyWriteIntent("Meta mein campaign pause kar do.")).toEqual({ verdict: "ACTION" });
  });

  it("a task-recording imperative stays ACTION", () => {
    expect(classifyWriteIntent("Create a task to check my system status")).toEqual({
      verdict: "ACTION",
    });
  });

  // -------------------------------------------------------------------------
  // Deictic / generic orders the security suites rely on: these must reach the
  // approval boundary (which is where they are gated), never be refused by the
  // gate as if the user had not asked.
  // -------------------------------------------------------------------------
  it.each(["do the thing", "run lead sync", "run the lead sync", "run the workflow", "message the customer", "tell them it shipped"])(
    "generic order '%s' stays ACTION",
    (msg) => {
      expect(classifyWriteIntent(msg)).toEqual({ verdict: "ACTION" });
    }
  );

  it("an info-request framing beats a coincidental verb", () => {
    expect(classifyWriteIntent("Tell me about the campaign budget")).toEqual({
      verdict: "INFO",
      reason: "question",
    });
    expect(classifyWriteIntent("How do I change the budget?")).toEqual({
      verdict: "INFO",
      reason: "question",
    });
    expect(classifyWriteIntent("Do you know the campaign status?")).toEqual({
      verdict: "INFO",
      reason: "question",
    });
    expect(classifyWriteIntent("Update me on the project budget")).toEqual({
      verdict: "INFO",
      reason: "question",
    });
  });

  it("a polite request to change is still ACTION, not info framing", () => {
    expect(classifyWriteIntent("Could you please update the campaign budget?")).toEqual({
      verdict: "ACTION",
    });
  });

  // -------------------------------------------------------------------------
  // Confirmations the assistant proposed — reused from intent-detector.
  // -------------------------------------------------------------------------
  it.each(["yes", "haan kar do", "go ahead", "please do", "create it", "do it", "sure"])(
    "confirmation '%s' is ACTION",
    (msg) => {
      expect(classifyWriteIntent(msg)).toEqual({ verdict: "ACTION" });
    }
  );

  // -------------------------------------------------------------------------
  // Requests phrased as questions must not be demoted to INFO.
  // -------------------------------------------------------------------------
  it("a polite request 'Can you change the budget to ₹50,000?' is ACTION", () => {
    expect(classifyWriteIntent("Can you change the campaign budget to ₹50,000?")).toEqual({
      verdict: "ACTION",
    });
  });

  it("an informational question is INFO (question)", () => {
    expect(classifyWriteIntent("What is the current budget of the campaign?")).toEqual({
      verdict: "INFO",
      reason: "question",
    });
  });

  // -------------------------------------------------------------------------
  // Hedges and under-specification stay out of ACTION.
  // -------------------------------------------------------------------------
  it("a trailing hedge demotes an instruction to AMBIGUOUS", () => {
    expect(classifyWriteIntent("Change the budget to 50000, maybe")).toEqual({
      verdict: "AMBIGUOUS",
      reason: "hedged",
    });
  });

  it("a bare 'the budget should change' stays non-ACTION", () => {
    const verdict = classifyWriteIntent("The budget should change");
    expect(verdict.verdict).not.toBe("ACTION");
  });
});