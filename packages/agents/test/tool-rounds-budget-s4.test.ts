// ---------------------------------------------------------------------------
// Skill System V1 — Phase S4: the context budget.
//
// Accumulating rounds is the point of S4 and also its one risk: a tool that
// returns a large document, called four times, would otherwise grow the prompt
// without limit. The budget bounds that, and these tests pin the three
// properties that make it safe rather than merely present:
//
//   OLDEST FIRST     what is dropped is dropped from the far end;
//   NEWEST KEPT      the result the caller just asked for is never elided,
//                    even alone over budget — eliding it would make a turn
//                    WORSE than before S4;
//   ELIDED, NOT GONE the `tool` message stays, carrying tool id and status,
//                    because the provider protocol rejects an assistant tool
//                    call that nothing answers.
//
// That last one is the non-obvious constraint. "Drop old results" is the
// natural instinct and it produces a request the provider refuses.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { AICompletionResponse, ToolExecutionResult } from "@jarvis/core";
import {
  DEFAULT_TOOL_RESULT_BUDGET_CHARS,
  budgetedEnvelopes,
  buildRoundMessages,
  type ToolRound,
} from "../src/tool-rounds.js";

function result(toolId: string, callId: string, status = "completed"): ToolExecutionResult {
  return {
    executionId: "exec-1",
    toolId,
    toolCallId: callId,
    status: status as ToolExecutionResult["status"],
    startedAt: new Date(0),
    completedAt: new Date(0),
    durationMs: 1,
  };
}

function assistant(...calls: Array<{ id: string; name: string }>): AICompletionResponse {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: {} })),
    },
    finishReason: "tool_calls",
    model: "test",
  };
}

/** Four rounds, one tool each, each rendering to `size` characters. */
function rounds(count: number): ToolRound[] {
  return Array.from({ length: count }, (_, i) => ({
    assistant: assistant({ id: `c${i}`, name: `tool.${i}` }),
    results: [result(`tool.${i}`, `c${i}`)],
  }));
}

const sized = (size: number) => (tr: ToolExecutionResult) =>
  `TOOL: ${tr.toolId}\n${tr.toolId.toUpperCase()}-BODY-${"x".repeat(Math.max(0, size))}`;

describe("G. the accumulated tool context is bounded", () => {
  it("keeps everything when everything fits", () => {
    const out = budgetedEnvelopes(rounds(4), sized(50), 10_000);
    expect(out.flat().every((e) => e.includes("BODY"))).toBe(true);
  });

  it("elides the OLDEST first when it does not", () => {
    // Four results of ~600 chars each in a 1 500 budget: the newest two fit.
    const out = budgetedEnvelopes(rounds(4), sized(600), 1_500).flat();

    expect(out[3]).toContain("BODY"); // newest — whole
    expect(out[2]).toContain("BODY");
    expect(out[0]).toContain("omitted"); // oldest — elided
    expect(out[0]).not.toContain("BODY");
  });

  it("never elides the newest result, even alone over budget", () => {
    const out = budgetedEnvelopes(rounds(3), sized(5_000), 100).flat();

    expect(out[2]).toContain("BODY");
    expect(out[0]).toContain("omitted");
    expect(out[1]).toContain("omitted");
  });

  it("keeps tool identity and status on an elided result", () => {
    const out = budgetedEnvelopes(
      [
        { assistant: assistant({ id: "c0", name: "meta.insights" }), results: [result("meta.insights", "c0", "failed")] },
        { assistant: assistant({ id: "c1", name: "meta.analyze" }), results: [result("meta.analyze", "c1")] },
      ],
      sized(5_000),
      100
    ).flat();

    // "I already tried that and it failed" is the fact that stops a model
    // trying again, so status must outlive the payload.
    expect(out[0]).toContain("meta.insights");
    expect(out[0]).toContain("STATUS: FAILED");
    expect(out[0]).not.toContain("BODY");
  });

  it("is deterministic", () => {
    const a = budgetedEnvelopes(rounds(5), sized(400), 900);
    const b = budgetedEnvelopes(rounds(5), sized(400), 900);
    expect(a).toEqual(b);
  });

  it("does not grow without limit as rounds accumulate", () => {
    const measure = (n: number) =>
      budgetedEnvelopes(rounds(n), sized(800), 2_000).flat().join("").length;

    const four = measure(4);
    const twenty = measure(20);

    // The elided stub costs something, so growth is not flat — but it is a
    // short constant per result rather than the payload.
    expect(four).toBeLessThan(4_000);
    expect(twenty - four).toBeLessThan(16 * 200);
  });

  it("returns one rendered entry per result, in the original order", () => {
    const out = budgetedEnvelopes(rounds(3), sized(10), 10_000);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.length)).toEqual([1, 1, 1]);
    expect(out[0]![0]).toContain("tool.0");
    expect(out[2]![0]).toContain("tool.2");
  });

  it("handles a round that produced no results", () => {
    const withEmpty: ToolRound[] = [
      { assistant: assistant({ id: "c0", name: "tool.0" }), results: [] },
      { assistant: assistant({ id: "c1", name: "tool.1" }), results: [result("tool.1", "c1")] },
    ];
    expect(() => budgetedEnvelopes(withEmpty, sized(10), 1_000)).not.toThrow();
    expect(budgetedEnvelopes(withEmpty, sized(10), 1_000)[0]).toEqual([]);
  });

  it("declares a budget, and it is the one used by default", () => {
    expect(DEFAULT_TOOL_RESULT_BUDGET_CHARS).toBe(12_000);

    const big = budgetedEnvelopes(rounds(40), sized(1_000)).flat();
    expect(big.some((e) => e.includes("omitted"))).toBe(true);
    expect(big[big.length - 1]).toContain("BODY");
  });
});

describe("the replayed message list", () => {
  const built = () =>
    buildRoundMessages({
      systemPrompt: "SYS",
      conversationHistory: [{ role: "user", content: "earlier" }],
      userMessage: "the original question",
      rounds: rounds(3),
      renderEnvelope: sized(10),
    });

  it("opens with system, history and the original question", () => {
    const m = built();
    expect(m[0]).toMatchObject({ role: "system", content: "SYS" });
    expect(m[1]).toMatchObject({ role: "user", content: "earlier" });
    expect(m[2]).toMatchObject({ role: "user", content: "the original question" });
  });

  it("emits one assistant turn and its tool answers per round, oldest first", () => {
    const roles = built().map((m) => m.role);
    expect(roles).toEqual([
      "system",
      "user",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
  });

  it("answers every announced tool call, so the provider will accept it", () => {
    const m = built();
    const announced = m.flatMap((x) => (x.role === "assistant" ? (x.toolCalls ?? []).map((tc) => tc.id) : []));
    const answered = m.filter((x) => x.role === "tool").map((x) => x.toolCallId);
    expect(answered.sort()).toEqual(announced.sort());
  });

  it("still answers a call whose result carries no call id", () => {
    const orphan: ToolRound[] = [
      {
        assistant: assistant({ id: "c0", name: "tool.0" }),
        results: [{ ...result("tool.0", "c0"), toolCallId: undefined }],
      },
    ];
    const m = buildRoundMessages({
      systemPrompt: "SYS",
      userMessage: "q",
      rounds: orphan,
      renderEnvelope: sized(5),
    });
    expect(m.find((x) => x.role === "tool")!.toolCallId).toBe("c0");
  });

  it("keeps an elided message in place rather than dropping it", () => {
    const m = buildRoundMessages({
      systemPrompt: "SYS",
      userMessage: "q",
      rounds: rounds(3),
      renderEnvelope: sized(5_000),
      budgetChars: 100,
    });
    // Three tool messages regardless: removing one would leave an assistant
    // tool call unanswered and the request would be rejected.
    expect(m.filter((x) => x.role === "tool")).toHaveLength(3);
  });

  it("omits the system message when there is no prompt", () => {
    const m = buildRoundMessages({
      systemPrompt: "",
      userMessage: "q",
      rounds: rounds(1),
      renderEnvelope: sized(5),
    });
    expect(m[0]!.role).toBe("user");
  });
});
