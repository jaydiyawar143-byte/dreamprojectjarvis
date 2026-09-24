// ---------------------------------------------------------------------------
// Execution Outcome & Evaluation — Phase S5, the projection.
//
// S5 is an OBSERVER. This file pins the two properties that make that true and
// keep it true:
//
//   DERIVED   every field comes from audit rows that already existed. The
//             projection adds no fact, and re-deriving it from the same rows
//             always produces the same object.
//   SEPARATE  what the system DID and whether the user LIKED it are two
//             different questions with two different answers. A tool returning
//             `success` is not a rating, and a turn nobody rated is not a turn
//             somebody disliked.
//
// That second one is why `feedback: null` gets its own tests. If null and
// NOT_HELPFUL are ever allowed to blur, a later learning layer inherits a
// dataset where "not asked" reads as "bad", and every conclusion drawn from it
// is wrong in the same direction.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  buildExecutionOutcome,
  isUserFeedback,
  FEEDBACK_AUDIT_ACTION,
  ORCHESTRATION_AUDIT_ACTION,
} from "../src/execution-outcome.js";
import { skillsForToolIds } from "../src/capability-presentation.js";
import type { AuditEntry } from "../src/types/common.js";

const TRACE = "trace-1";
let clock = 0;

function entry(over: Partial<AuditEntry> & { action: string }): AuditEntry {
  clock += 1000;
  return {
    id: `a${clock}`,
    timestamp: new Date(clock),
    userId: "user-1",
    parameters: {},
    result: "success",
    traceId: TRACE,
    metadata: {},
    ...over,
  };
}

function toolRow(toolId: string, result: AuditEntry["result"] = "success", meta = {}) {
  return entry({
    action: "tool.execute",
    toolId,
    result,
    agentId: "conversational-assistant",
    metadata: meta,
  });
}

// ---------------------------------------------------------------------------
// A. The projection
// ---------------------------------------------------------------------------

describe("A. an execution outcome is derived from the audit rows", () => {
  it("reports a single tool execution", () => {
    const out = buildExecutionOutcome(TRACE, [
      toolRow("meta.insights"),
      entry({ action: ORCHESTRATION_AUDIT_ACTION, agentId: "conversational-assistant" }),
    ]);

    expect(out.traceId).toBe(TRACE);
    expect(out.tools.map((t) => t.toolId)).toEqual(["meta.insights"]);
    expect(out.toolsSucceeded).toBe(1);
    expect(out.toolsFailed).toBe(0);
    expect(out.outcome).toBe("success");
  });

  it("reports several executions in the order they happened", () => {
    const out = buildExecutionOutcome(TRACE, [
      toolRow("meta.insights"),
      toolRow("meta.campaigns"),
      toolRow("integration.list"),
    ]);
    expect(out.tools.map((t) => t.toolId)).toEqual([
      "meta.insights",
      "meta.campaigns",
      "integration.list",
    ]);
  });

  it("sorts by timestamp rather than trusting the order rows arrive in", () => {
    const first = toolRow("meta.insights");
    const second = toolRow("maps.nearby");
    const out = buildExecutionOutcome(TRACE, [second, first]);
    expect(out.tools.map((t) => t.toolId)).toEqual(["meta.insights", "maps.nearby"]);
  });

  it("counts a failed tool as failed, not as absent", () => {
    const out = buildExecutionOutcome(TRACE, [
      toolRow("meta.insights"),
      toolRow("maps.search", "failure"),
    ]);
    expect(out.toolsSucceeded).toBe(1);
    expect(out.toolsFailed).toBe(1);
    expect(out.tools).toHaveLength(2);
  });

  it("counts a policy denial separately from a tool failure", () => {
    // A denied call never reached the executor. Calling it a "failed tool"
    // would put a policy decision in the same bucket as a provider outage.
    const out = buildExecutionOutcome(TRACE, [
      toolRow("meta.insights"),
      entry({ action: "agent.tool_denied", toolId: "whatsapp.send", result: "rejected" }),
    ]);
    expect(out.toolsDenied).toBe(1);
    expect(out.toolsFailed).toBe(0);
    expect(out.tools.map((t) => t.toolId)).toEqual(["meta.insights"]);
  });

  it("records approval decisions", () => {
    const out = buildExecutionOutcome(TRACE, [
      toolRow("meta.campaign.pause", "pending"),
      entry({ action: "approval.approve", result: "success" }),
    ]);
    expect(out.approvals.map((a) => a.action)).toEqual(["approval.approve"]);
  });

  it("carries the execution id and duration when the writer recorded them", () => {
    const out = buildExecutionOutcome(TRACE, [
      toolRow("meta.insights", "success", { executionId: "exec-9", durationMs: 42 }),
    ]);
    expect(out.tools[0]!.executionId).toBe("exec-9");
    expect(out.tools[0]!.durationMs).toBe(42);
  });

  it("lists every agent that appears, first-seen order", () => {
    const out = buildExecutionOutcome(TRACE, [
      entry({ action: "tool.execute", toolId: "meta.insights", agentId: "meta-ads-agent" }),
      entry({ action: ORCHESTRATION_AUDIT_ACTION, agentId: "conversational-assistant" }),
    ]);
    expect(out.agents).toEqual(["meta-ads-agent", "conversational-assistant"]);
  });
});

// ---------------------------------------------------------------------------
// Partial and missing information
// ---------------------------------------------------------------------------

describe("partial audit information does not break the projection", () => {
  it("returns a well-formed outcome for no rows at all", () => {
    const out = buildExecutionOutcome(TRACE, []);
    expect(out.tools).toEqual([]);
    expect(out.skills).toEqual([]);
    expect(out.outcome).toBeNull();
    expect(out.feedback).toBeNull();
    expect(out.durationMs).toBeNull();
  });

  it("reports a null outcome when no orchestration row exists", () => {
    // An in-flight or abandoned request. Null means "not concluded", which is
    // not the same as concluded badly.
    const out = buildExecutionOutcome(TRACE, [toolRow("meta.insights")]);
    expect(out.outcome).toBeNull();
    expect(out.toolsSucceeded).toBe(1);
  });

  it("survives a tool row with no toolId", () => {
    const out = buildExecutionOutcome(TRACE, [entry({ action: "tool.execute" })]);
    expect(out.tools).toEqual([]);
  });

  it("ignores metadata of the wrong shape", () => {
    const out = buildExecutionOutcome(TRACE, [
      toolRow("meta.insights", "success", { executionId: 42, durationMs: "fast" }),
    ]);
    expect(out.tools[0]!.executionId).toBeUndefined();
    expect(out.tools[0]!.durationMs).toBeUndefined();
  });

  it("takes the LAST orchestration verdict when a trace has several", () => {
    const out = buildExecutionOutcome(TRACE, [
      entry({ action: ORCHESTRATION_AUDIT_ACTION, result: "failure" }),
      entry({ action: ORCHESTRATION_AUDIT_ACTION, result: "success" }),
    ]);
    expect(out.outcome).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// B. Skill attribution — the S2 mapping, reused
// ---------------------------------------------------------------------------

describe("B. skills come from skillsForToolIds, not a second mapping", () => {
  it("attributes executed tools to their skills", () => {
    const out = buildExecutionOutcome(TRACE, [
      toolRow("meta.insights"),
      toolRow("maps.nearby"),
      toolRow("integration.list"),
    ]);
    expect(out.skills).toEqual(["advertising", "places", "integrations"]);
  });

  it("agrees exactly with the shared helper", () => {
    const ids = ["meta.insights", "gmail.search", "maps.nearby"];
    const out = buildExecutionOutcome(TRACE, ids.map((id) => toolRow(id)));
    expect(out.skills).toEqual(skillsForToolIds(ids));
  });

  it("attributes nothing to the intentionally unlisted tools", () => {
    const out = buildExecutionOutcome(TRACE, [toolRow("self.describe"), toolRow("task.create")]);
    expect(out.skills).toEqual([]);
    expect(out.tools).toHaveLength(2);
  });

  it("invents no skill for an unknown tool id", () => {
    const out = buildExecutionOutcome(TRACE, [toolRow("totally.unknown")]);
    expect(out.skills).toEqual([]);
  });

  it("does not attribute a DENIED tool to a skill", () => {
    // It never ran. Counting it as skill participation would report work that
    // did not happen.
    const out = buildExecutionOutcome(TRACE, [
      entry({ action: "agent.tool_denied", toolId: "whatsapp.send", result: "rejected" }),
    ]);
    expect(out.skills).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C. Trace grouping
// ---------------------------------------------------------------------------

describe("C. one projection is one request", () => {
  it("ignores rows belonging to another trace", () => {
    const mine = toolRow("meta.insights");
    const theirs = { ...toolRow("whatsapp.send"), traceId: "trace-2" };
    const out = buildExecutionOutcome(TRACE, [mine, theirs]);

    expect(out.tools.map((t) => t.toolId)).toEqual(["meta.insights"]);
    expect(out.skills).toEqual(["advertising"]);
  });

  it("keeps two traces separate when projected separately", () => {
    const rows = [
      toolRow("meta.insights"),
      { ...toolRow("maps.nearby"), traceId: "trace-2" } as AuditEntry,
    ];
    expect(buildExecutionOutcome("trace-1", rows).tools).toHaveLength(1);
    expect(buildExecutionOutcome("trace-2", rows).tools).toHaveLength(1);
    expect(buildExecutionOutcome("trace-1", rows).skills).toEqual(["advertising"]);
    expect(buildExecutionOutcome("trace-2", rows).skills).toEqual(["places"]);
  });

  it("returns an empty outcome for a trace with no matching rows", () => {
    const out = buildExecutionOutcome("trace-absent", [toolRow("meta.insights")]);
    expect(out.tools).toEqual([]);
    expect(out.outcome).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D. User feedback — and its distance from execution outcome
// ---------------------------------------------------------------------------

describe("D. the explicit signal", () => {
  it("reports HELPFUL when one was recorded", () => {
    const out = buildExecutionOutcome(TRACE, [
      toolRow("meta.insights"),
      entry({ action: FEEDBACK_AUDIT_ACTION, metadata: { feedback: "HELPFUL" } }),
    ]);
    expect(out.feedback).toBe("HELPFUL");
    expect(out.feedbackAt).toBeInstanceOf(Date);
  });

  it("reports NOT_HELPFUL when one was recorded", () => {
    const out = buildExecutionOutcome(TRACE, [
      toolRow("meta.insights"),
      entry({ action: FEEDBACK_AUDIT_ACTION, metadata: { feedback: "NOT_HELPFUL" } }),
    ]);
    expect(out.feedback).toBe("NOT_HELPFUL");
  });

  it("keeps ABSENT distinct from NOT_HELPFUL", () => {
    // The whole reason this field is nullable. If these two ever collapse, a
    // later learning layer reads "never asked" as "disliked".
    const unrated = buildExecutionOutcome(TRACE, [toolRow("meta.insights")]);
    expect(unrated.feedback).toBeNull();
    expect(unrated.feedbackAt).toBeNull();
    expect(unrated.feedback).not.toBe("NOT_HELPFUL");
  });

  it("takes the latest signal when the user changed their mind", () => {
    const out = buildExecutionOutcome(TRACE, [
      entry({ action: FEEDBACK_AUDIT_ACTION, metadata: { feedback: "HELPFUL" } }),
      entry({ action: FEEDBACK_AUDIT_ACTION, metadata: { feedback: "NOT_HELPFUL" } }),
    ]);
    expect(out.feedback).toBe("NOT_HELPFUL");
  });

  it("ignores a feedback row carrying a value it does not recognise", () => {
    const out = buildExecutionOutcome(TRACE, [
      entry({ action: FEEDBACK_AUDIT_ACTION, metadata: { feedback: "AMAZING" } }),
      entry({ action: FEEDBACK_AUDIT_ACTION, metadata: {} }),
    ]);
    expect(out.feedback).toBeNull();
  });

  it("validates the vocabulary, and only that vocabulary", () => {
    expect(isUserFeedback("HELPFUL")).toBe(true);
    expect(isUserFeedback("NOT_HELPFUL")).toBe(true);
    for (const bad of ["helpful", "GREAT", "", null, undefined, 1, {}]) {
      expect(isUserFeedback(bad)).toBe(false);
    }
  });
});

describe("execution outcome and user feedback are never conflated", () => {
  it("does not treat a successful tool as a positive rating", () => {
    const out = buildExecutionOutcome(TRACE, [
      toolRow("meta.insights"),
      entry({ action: ORCHESTRATION_AUDIT_ACTION, result: "success" }),
    ]);
    expect(out.outcome).toBe("success");
    expect(out.feedback).toBeNull();
  });

  it("does not treat a failed turn as a negative rating", () => {
    const out = buildExecutionOutcome(TRACE, [
      toolRow("maps.search", "failure"),
      entry({ action: ORCHESTRATION_AUDIT_ACTION, result: "failure" }),
    ]);
    expect(out.outcome).toBe("failure");
    expect(out.feedback).toBeNull();
  });

  it("lets a technically successful turn be rated NOT_HELPFUL", () => {
    // The case that matters most: everything ran, and the answer was useless.
    const out = buildExecutionOutcome(TRACE, [
      toolRow("meta.insights"),
      entry({ action: ORCHESTRATION_AUDIT_ACTION, result: "success" }),
      entry({ action: FEEDBACK_AUDIT_ACTION, metadata: { feedback: "NOT_HELPFUL" } }),
    ]);
    expect(out.outcome).toBe("success");
    expect(out.feedback).toBe("NOT_HELPFUL");
  });

  it("lets a technically failed turn be rated HELPFUL", () => {
    const out = buildExecutionOutcome(TRACE, [
      toolRow("maps.search", "failure"),
      entry({ action: ORCHESTRATION_AUDIT_ACTION, result: "failure" }),
      entry({ action: FEEDBACK_AUDIT_ACTION, metadata: { feedback: "HELPFUL" } }),
    ]);
    expect(out.outcome).toBe("failure");
    expect(out.feedback).toBe("HELPFUL");
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe("the projection is pure", () => {
  it("is deterministic for the same rows", () => {
    const rows = [
      toolRow("meta.insights"),
      toolRow("maps.nearby", "failure"),
      entry({ action: FEEDBACK_AUDIT_ACTION, metadata: { feedback: "HELPFUL" } }),
      entry({ action: ORCHESTRATION_AUDIT_ACTION }),
    ];
    expect(buildExecutionOutcome(TRACE, rows)).toEqual(buildExecutionOutcome(TRACE, rows));
  });

  it("does not mutate the rows it was handed", () => {
    const rows = [toolRow("meta.insights"), toolRow("maps.nearby")];
    const before = JSON.stringify(rows);
    buildExecutionOutcome(TRACE, rows);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it("carries nothing callable", () => {
    const out = buildExecutionOutcome(TRACE, [toolRow("meta.insights")]);
    for (const value of Object.values(out)) expect(typeof value).not.toBe("function");
  });
});
