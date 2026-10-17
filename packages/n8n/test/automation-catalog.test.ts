// ---------------------------------------------------------------------------
// Phase 16, Stage 2 — the unified read-only automation view
//
// These tests pin the four properties the view must keep:
//
//   • source provenance — a record says which surface(s) observed it;
//   • collision-safe ids — two automations that merely share a name never merge,
//     and two surfaces that name the same workflow id always do;
//   • source separation — an UNREAD surface contributes nothing and is reported
//     unavailable, never as an empty list;
//   • no invocation — the builder is handed plain data and holds no connector,
//     so it cannot execute anything.
//
// Nothing here reaches a network or a database.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { buildAutomationCatalog } from "../src/automation-catalog.js";
import type { N8nMcpTool } from "../src/mcp-connector.js";

function tool(overrides: Partial<N8nMcpTool> & { name: string }): N8nMcpTool {
  return {
    description: null,
    inputSchema: null,
    readOnly: false,
    destructive: false,
    ...overrides,
  };
}

const UNREAD_REST = { available: false, reason: "The n8n REST surface was not read." } as const;

describe("Phase 16 Stage 2 — buildAutomationCatalog", () => {
  it("builds an MCP-only view and reports REST as unread, not empty", () => {
    const catalog = buildAutomationCatalog({
      rest: UNREAD_REST,
      mcp: {
        available: true,
        items: [tool({ name: "send_email" }), tool({ name: "list_sheets", readOnly: true })],
      },
    });

    expect(catalog.records).toHaveLength(2);
    expect(catalog.records.every((r) => r.kind === "tool")).toBe(true);
    expect(catalog.records.every((r) => r.observedVia.join(",") === "mcp")).toBe(true);

    // REST is present-but-false with a reason — distinguished from "read and empty".
    expect(catalog.sources.rest).toEqual({
      connector: "rest",
      available: false,
      reason: "The n8n REST surface was not read.",
      count: 0,
    });
    expect(catalog.sources.mcp).toEqual({
      connector: "mcp",
      available: true,
      reason: null,
      count: 2,
    });
    expect(catalog.connectors.find((c) => c.connector === "rest")).toEqual({
      connector: "rest",
      available: false,
      operations: [],
    });
  });

  it("builds a REST-only view with workflow provenance", () => {
    const catalog = buildAutomationCatalog({
      rest: {
        available: true,
        items: [
          { id: "wf-1", name: "Nightly sync", active: true },
          { id: "wf-2", name: "Paused job", active: false },
        ],
      },
      mcp: { available: true, items: [] },
    });

    expect(catalog.records).toHaveLength(2);
    const wf2 = catalog.records.find((r) => r.externalId === "wf-2")!;
    // `available` is the provider's own answer, not assumed from discovery.
    expect(wf2.available).toBe(false);
    expect(wf2.observedVia.join(",")).toBe("rest");

    // An available-but-empty MCP surface is available, with count 0.
    expect(catalog.sources.mcp.available).toBe(true);
    expect(catalog.sources.mcp.count).toBe(0);
  });

  it("never merges two automations that merely share a name", () => {
    const catalog = buildAutomationCatalog({
      rest: { available: true, items: [{ id: "wf-1", name: "report", active: true }] },
      mcp: {
        available: true,
        // Same NAME as the workflow, but the tool names no workflow id.
        items: [tool({ name: "report" })],
      },
    });

    // Two records: a workflow and a tool, identities distinct by kind+externalId.
    expect(catalog.records).toHaveLength(2);
    expect(catalog.records.map((r) => r.kind).sort()).toEqual(["tool", "workflow"]);
  });

  it("merges the two surfaces when a tool names the workflow it targets", () => {
    const catalog = buildAutomationCatalog({
      rest: { available: true, items: [{ id: "wf-9", name: "Invoice chase", active: true }] },
      mcp: {
        available: true,
        items: [
          tool({
            name: "invoice_chase",
            inputSchema: { workflowId: "wf-9" },
          }),
        ],
      },
    });

    expect(catalog.records).toHaveLength(1);
    const merged = catalog.records[0]!;
    expect(merged.kind).toBe("workflow");
    expect(merged.observedVia).toEqual(["mcp", "rest"]);
    expect(merged.handles).toEqual({ mcp: "invoice_chase", rest: "wf-9" });
    // `execute` appears because the tool declares it; it is a capability, not a
    // performed action.
    expect(merged.operations).toContain("execute");
  });

  it("is deterministic and order-independent", () => {
    const workflows = [
      { id: "wf-b", name: "B", active: true },
      { id: "wf-a", name: "A", active: true },
    ];
    const tools = [tool({ name: "b_tool" }), tool({ name: "a_tool" })];
    const first = buildAutomationCatalog({
      rest: { available: true, items: workflows },
      mcp: { available: true, items: tools },
    });
    const second = buildAutomationCatalog({
      rest: { available: true, items: [...workflows].reverse() },
      mcp: { available: true, items: [...tools].reverse() },
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // Sorted by identity (providerId:kind:externalId).
    const ids = first.records.map((r) => r.externalId);
    expect(ids).toEqual([...ids].sort());
  });

  it("contributes nothing from an unread surface", () => {
    const catalog = buildAutomationCatalog({
      rest: { available: false, reason: "REST not read." },
      mcp: { available: false, reason: "MCP off." },
    });
    expect(catalog.records).toEqual([]);
    expect(catalog.connectors).toEqual([
      { connector: "rest", available: false, operations: [] },
      { connector: "mcp", available: false, operations: [] },
    ]);
  });

  it("does not invoke anything — its inputs are plain data and stay untouched", () => {
    const items = [tool({ name: "send_email" })];
    const workflows = [{ id: "wf-1", name: "W", active: true }];
    const rest = { available: true as const, items: workflows };
    const mcp = { available: true as const, items };

    const catalog = buildAutomationCatalog({ rest, mcp });

    // The inputs are unchanged (the builder copies, it does not mutate), and no
    // record carries execution output — only descriptive fields.
    expect(items).toEqual([tool({ name: "send_email" })]);
    expect(workflows).toEqual([{ id: "wf-1", name: "W", active: true }]);
    for (const record of catalog.records) {
      expect(Object.keys(record).sort()).toEqual(
        [
          "available",
          "description",
          "externalId",
          "handles",
          "kind",
          "metadata",
          "name",
          "observedVia",
          "operations",
          "providerId",
        ].sort()
      );
    }
  });
});
