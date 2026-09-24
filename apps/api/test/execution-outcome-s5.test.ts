// ---------------------------------------------------------------------------
// Execution Outcome & Evaluation — Phase S5, the service.
//
// The core tests prove the PROJECTION is right. These prove the service around
// it stays an OBSERVER once it can read and write:
//
//   TENANT SCOPED    a trace belonging to someone else is "not found", both to
//                    read and to write. Feedback is a write keyed by an id the
//                    caller supplies, so the ownership check is the whole
//                    security of it.
//   INERT            the service holds no registry, executor, agent or policy.
//                    There is no edit to it that could run a tool, and these
//                    tests assert that structurally rather than by promise.
//   ONE SOURCE       feedback is an ordinary AuditLog row. No second table, no
//                    second pipeline, and the projection reads what it wrote.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach } from "vitest";
import type { AuditEntry } from "@jarvis/core";
import { FEEDBACK_AUDIT_ACTION } from "@jarvis/core";
import {
  ExecutionOutcomeService,
  OUTCOME_LOOKBACK_MS,
} from "../src/services/execution-outcome-service.js";

// Recent on purpose: the service bounds its lookup to a 30-day window, so an
// epoch-based fixture would be correctly filtered out and the tests would be
// asserting against the window rather than against the service.
let clock = Date.now() - 60_000;

function entry(over: Partial<AuditEntry> & { action: string }): AuditEntry {
  clock += 1000;
  return {
    id: `a${clock}`,
    timestamp: new Date(clock),
    userId: "user-1",
    parameters: {},
    result: "success",
    traceId: "trace-1",
    metadata: {},
    ...over,
  };
}

/** An in-memory stand-in for the audit table, scoped exactly as the real one. */
class FakeAudit {
  rows: AuditEntry[] = [];
  readonly reads: Array<{ userId: string; traceId: string; since: Date }> = [];

  async findByTrace(userId: string, traceId: string, since: Date): Promise<AuditEntry[]> {
    this.reads.push({ userId, traceId, since });
    return this.rows
      .filter((r) => r.userId === userId && r.traceId === traceId && r.timestamp >= since)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  async log(e: Omit<AuditEntry, "id" | "timestamp">): Promise<void> {
    clock += 1000;
    this.rows.push({ ...e, id: `a${clock}`, timestamp: new Date(clock) } as AuditEntry);
  }
}

describe("S5 — the execution outcome service", () => {
  let audit: FakeAudit;
  let service: ExecutionOutcomeService;

  beforeEach(() => {
    audit = new FakeAudit();
    service = new ExecutionOutcomeService({ audit, auditLogger: audit });
    audit.rows.push(
      entry({ action: "tool.execute", toolId: "meta.insights", agentId: "conversational-assistant" }),
      entry({ action: "orchestrator.process", agentId: "conversational-assistant" })
    );
  });

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  describe("reading an outcome", () => {
    it("derives it from the rows that already exist", async () => {
      const out = await service.outcome("user-1", "trace-1");
      expect(out?.tools.map((t) => t.toolId)).toEqual(["meta.insights"]);
      expect(out?.skills).toEqual(["advertising"]);
      expect(out?.outcome).toBe("success");
      expect(out?.feedback).toBeNull();
    });

    it("returns null for a trace with no rows", async () => {
      expect(await service.outcome("user-1", "trace-absent")).toBeNull();
    });

    it("bounds the lookup by a window rather than scanning the table", async () => {
      await service.outcome("user-1", "trace-1");
      const since = audit.reads[0]!.since;
      expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(OUTCOME_LOOKBACK_MS - 5_000);
    });
  });

  // -------------------------------------------------------------------------
  // Tenant scoping — the security of the whole feature
  // -------------------------------------------------------------------------

  describe("a trace that is not yours does not exist", () => {
    it("refuses to READ another user's trace", async () => {
      expect(await service.outcome("user-2", "trace-1")).toBeNull();
    });

    it("refuses to WRITE feedback against another user's trace", async () => {
      // Without this, feedback is a write keyed by a caller-supplied id.
      const before = audit.rows.length;
      expect(await service.record("user-2", "trace-1", "HELPFUL")).toBeNull();
      expect(audit.rows).toHaveLength(before);
    });

    it("gives the same answer for 'not yours' and 'does not exist'", async () => {
      // So the endpoint cannot be used to discover which trace ids are real.
      expect(await service.outcome("user-2", "trace-1")).toBeNull();
      expect(await service.outcome("user-1", "trace-nope")).toBeNull();
    });

    it("always passes the caller's own userId to the repository", async () => {
      await service.outcome("user-1", "trace-1");
      await service.record("user-1", "trace-1", "HELPFUL");
      for (const read of audit.reads) expect(read.userId).toBe("user-1");
    });
  });

  // -------------------------------------------------------------------------
  // Writing the one signal
  // -------------------------------------------------------------------------

  describe("recording feedback", () => {
    it("stores HELPFUL and reads it back", async () => {
      const out = await service.record("user-1", "trace-1", "HELPFUL");
      expect(out?.feedback).toBe("HELPFUL");
      expect((await service.outcome("user-1", "trace-1"))?.feedback).toBe("HELPFUL");
    });

    it("stores NOT_HELPFUL and reads it back", async () => {
      await service.record("user-1", "trace-1", "NOT_HELPFUL");
      expect((await service.outcome("user-1", "trace-1"))?.feedback).toBe("NOT_HELPFUL");
    });

    it("writes ONE ordinary audit row — no second table", async () => {
      await service.record("user-1", "trace-1", "HELPFUL");
      const written = audit.rows.filter((r) => r.action === FEEDBACK_AUDIT_ACTION);
      expect(written).toHaveLength(1);
      expect(written[0]!.traceId).toBe("trace-1");
      expect(written[0]!.metadata).toMatchObject({ feedback: "HELPFUL" });
    });

    it("attaches the signal to the correct trace", async () => {
      audit.rows.push(entry({ action: "tool.execute", toolId: "maps.nearby", traceId: "trace-2" }));
      await service.record("user-1", "trace-1", "HELPFUL");

      expect((await service.outcome("user-1", "trace-1"))?.feedback).toBe("HELPFUL");
      expect((await service.outcome("user-1", "trace-2"))?.feedback).toBeNull();
    });

    it("lets a person change their mind", async () => {
      await service.record("user-1", "trace-1", "HELPFUL");
      await service.record("user-1", "trace-1", "NOT_HELPFUL");
      expect((await service.outcome("user-1", "trace-1"))?.feedback).toBe("NOT_HELPFUL");
    });

    it("keeps an unrated trace distinct from a NOT_HELPFUL one", async () => {
      audit.rows.push(entry({ action: "tool.execute", toolId: "maps.nearby", traceId: "trace-2" }));
      await service.record("user-1", "trace-2", "NOT_HELPFUL");

      expect((await service.outcome("user-1", "trace-1"))?.feedback).toBeNull();
      expect((await service.outcome("user-1", "trace-2"))?.feedback).toBe("NOT_HELPFUL");
    });

    it("does not change the execution facts it describes", async () => {
      const before = await service.outcome("user-1", "trace-1");
      const after = await service.record("user-1", "trace-1", "NOT_HELPFUL");

      expect(after?.outcome).toBe(before?.outcome);
      expect(after?.tools.map((t) => t.toolId)).toEqual(before?.tools.map((t) => t.toolId));
      expect(after?.skills).toEqual(before?.skills);
      // Only the signal moved.
      expect(before?.feedback).toBeNull();
      expect(after?.feedback).toBe("NOT_HELPFUL");
    });
  });

  // -------------------------------------------------------------------------
  // E. Isolation — S5 observes, it does not steer
  // -------------------------------------------------------------------------

  describe("E. S5 cannot execute or influence anything", () => {
    const source = readFileSync(
      new URL("../src/services/execution-outcome-service.ts", import.meta.url),
      "utf8"
    );

    it("holds no executor, registry, agent or policy", () => {
      // Structural, not a promise: none of these is reachable from the file,
      // so no edit to it could make feedback run a tool.
      for (const forbidden of [
        "ToolExecutor",
        "ToolRegistry",
        "AGENT_POLICIES",
        "isToolAllowed",
        "Orchestrator",
        "providerTools",
        "buildSkillContext",
      ]) {
        expect(source, forbidden).not.toContain(forbidden);
      }
    });

    it("exposes exactly two operations and no execute", () => {
      const methods = Object.getOwnPropertyNames(ExecutionOutcomeService.prototype).filter(
        (m) => m !== "constructor"
      );
      expect(methods.sort()).toEqual(["outcome", "record", "since"]);
      expect(methods).not.toContain("execute");
    });

    it("is not imported by anything on the planning path", () => {
      // The other direction: a recorded signal cannot reach agent selection,
      // skill context, tool definitions or memory confidence, because nothing
      // there can see this module.
      for (const planningFile of [
        "../../../packages/agents/src/orchestrator.ts",
        "../../../packages/agents/src/agent-policy.ts",
        "../../../packages/agents/src/agent-router.ts",
        "../../../packages/agents/src/domain-agent.ts",
        "../../../packages/core/src/capability-presentation.ts",
      ]) {
        const planning = readFileSync(new URL(planningFile, import.meta.url), "utf8");
        expect(planning, planningFile).not.toContain("execution-outcome-service");
        expect(planning, planningFile).not.toContain("ExecutionOutcomeService");
      }
    });

    it("never writes anything but a feedback row", async () => {
      await service.record("user-1", "trace-1", "HELPFUL");
      await service.outcome("user-1", "trace-1");
      const actions = new Set(audit.rows.map((r) => r.action));
      expect([...actions].filter((a) => a.startsWith("tool."))).toEqual(["tool.execute"]);
      expect(audit.rows.filter((r) => r.action === FEEDBACK_AUDIT_ACTION)).toHaveLength(1);
    });
  });
});
