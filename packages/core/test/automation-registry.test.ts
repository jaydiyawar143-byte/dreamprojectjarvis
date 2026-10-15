import { describe, it, expect } from "vitest";
import {
  automationIdentity,
  automationRecordFromMcpTool,
  automationRecordFromRestWorkflow,
  connectorStatus,
  mergeAutomationRecords,
  resolveAutomationRoute,
  type AutomationRecord,
} from "../src/automation-registry.js";

// ---------------------------------------------------------------------------
// The Automation Registry: normalization, deduplication and routing.
//
// Everything here is pure, so the tests assert exact shapes and exact ordering:
// two collections of the same automations must produce byte-identical output,
// and a route must be answered from what a connector DECLARED it can do.
// ---------------------------------------------------------------------------

function restWorkflow(id: string, name: string, active = true): AutomationRecord {
  return automationRecordFromRestWorkflow("n8n", { id, name, active });
}

describe("automation records — normalization", () => {
  it("takes availability from the workflow's own `active`, never from discovery", () => {
    const active = automationRecordFromRestWorkflow("n8n", { id: "1", name: "Daily", active: true });
    const inactive = automationRecordFromRestWorkflow("n8n", { id: "2", name: "Paused", active: false });
    expect(active.available).toBe(true);
    expect(inactive.available).toBe(false);
  });

  it("keeps the REST workflow id as the action handle and the connector as `rest`", () => {
    const record = restWorkflow("42", "Sync");
    expect(record.handles).toEqual({ rest: "42" });
    expect(record.observedVia).toEqual(["rest"]);
    expect(record.kind).toBe("workflow");
  });

  it("bounds metadata: only plain, time-valued fields survive", () => {
    const record = automationRecordFromRestWorkflow("n8n", {
      id: "1",
      name: "W",
      active: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: null,
    });
    expect(record.metadata).toEqual({ createdAt: "2026-01-01T00:00:00.000Z" });
  });

  it("marks a tool's readOnly hint in metadata and keeps its MCP name as the handle", () => {
    const record = automationRecordFromMcpTool("n8n", {
      name: "run_workflow",
      description: "Runs a workflow",
      readOnly: true,
    });
    expect(record.kind).toBe("tool");
    expect(record.handles).toEqual({ mcp: "run_workflow" });
    expect(record.observedVia).toEqual(["mcp"]);
    expect(record.metadata.readOnly).toBe("true");
    expect(record.available).toBe(true);
  });

  it("never claims `monitor` or `manage` for an MCP tool", () => {
    const record = automationRecordFromMcpTool("n8n", { name: "t" });
    expect(record.operations).toEqual(["describe", "execute", "list"]);
    expect(record.operations).not.toContain("monitor");
    expect(record.operations).not.toContain("manage");
  });
});

describe("mergeAutomationRecords — deduplication", () => {
  it("returns an empty list for no records", () => {
    expect(mergeAutomationRecords([])).toEqual([]);
  });

  it("collapses a record seen twice through the same connector", () => {
    const merged = mergeAutomationRecords([restWorkflow("1", "A"), restWorkflow("1", "A")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.observedVia).toEqual(["rest"]);
  });

  it("links a REST workflow and an MCP tool that name the same workflow id into one automation", () => {
    const workflow = restWorkflow("42", "Daily digest");
    const tool = automationRecordFromMcpTool("n8n", {
      name: "run_workflow",
      description: "Runs the daily digest",
      workflowId: "42",
    });

    const merged = mergeAutomationRecords([tool, workflow]);
    expect(merged).toHaveLength(1);
    const record = merged[0]!;
    // The workflow is the canonical identity of a linked pair.
    expect(record.kind).toBe("workflow");
    expect(record.externalId).toBe("42");
    expect(record.name).toBe("Daily digest");
    // Both surfaces are recorded, and both handles are kept.
    expect(record.observedVia).toEqual(["mcp", "rest"]);
    expect(record.handles).toEqual({ rest: "42", mcp: "run_workflow" });
    // Operations are the union: the tool's invoke and the workflow's monitor.
    expect(record.operations).toEqual(["describe", "execute", "list", "manage", "monitor"]);
  });

  it("does not link a tool whose workflowId belongs to a different provider", () => {
    const workflow = restWorkflow("42", "Daily");
    const tool = automationRecordFromMcpTool("other-n8n", {
      name: "run_workflow",
      workflowId: "42",
    });
    expect(mergeAutomationRecords([workflow, tool])).toHaveLength(2);
  });

  it("keeps unrelated automations apart", () => {
    const merged = mergeAutomationRecords([restWorkflow("1", "A"), restWorkflow("2", "B")]);
    expect(merged.map((r) => r.externalId)).toEqual(["1", "2"]);
  });

  it("is deterministic regardless of input order", () => {
    const a = restWorkflow("2", "B");
    const b = restWorkflow("1", "A");
    const tool = automationRecordFromMcpTool("n8n", { name: "t", workflowId: "1" });
    const forward = mergeAutomationRecords([a, b, tool]);
    const backward = mergeAutomationRecords([tool, b, a]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(backward));
  });

  it("gives every merged record a stable identity", () => {
    const [record] = mergeAutomationRecords([restWorkflow("7", "X")]);
    expect(automationIdentity(record!)).toBe("n8n:workflow:7");
  });
});

describe("resolveAutomationRoute — capability-based routing", () => {
  const bothAvailable = [
    connectorStatus("rest", true, ["list", "describe", "monitor", "manage", "execute"]),
    connectorStatus("mcp", true, ["list", "describe", "execute"]),
  ];

  it("prefers REST for listing and management", () => {
    for (const operation of ["list", "describe", "monitor", "manage"] as const) {
      const route = resolveAutomationRoute(operation, bothAvailable);
      expect(route.ok).toBe(true);
      if (route.ok) expect(route.connector).toBe("rest");
    }
  });

  it("prefers MCP for execution when MCP can genuinely execute", () => {
    const route = resolveAutomationRoute("execute", bothAvailable);
    expect(route).toMatchObject({ ok: true, connector: "mcp" });
  });

  it("falls back to REST for execution only when MCP is unavailable", () => {
    const route = resolveAutomationRoute("execute", [
      connectorStatus("rest", true, ["list", "describe", "monitor", "manage", "execute"]),
      connectorStatus("mcp", false, ["list", "describe", "execute"]),
    ]);
    expect(route).toMatchObject({ ok: true, connector: "rest" });
  });

  it("does not fall back to a reachable connector that does not declare the operation", () => {
    // MCP is up but cannot monitor; there is no REST. The answer is a refusal,
    // not a route MCP would fail.
    const route = resolveAutomationRoute("monitor", [
      connectorStatus("mcp", true, ["list", "describe", "execute"]),
    ]);
    expect(route.ok).toBe(false);
    if (!route.ok) expect(route.reason).toContain("monitor");
  });

  it("refuses with a reason naming what was reachable", () => {
    const none = resolveAutomationRoute("execute", []);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toContain("reachable");

    const unsupported = resolveAutomationRoute("manage", [
      connectorStatus("mcp", true, ["list", "describe", "execute"]),
    ]);
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.reason).toContain("mcp");
  });

  it("never routes to a connector by name alone — availability is required", () => {
    const route = resolveAutomationRoute("list", [connectorStatus("rest", false, ["list"])]);
    expect(route.ok).toBe(false);
  });
});
