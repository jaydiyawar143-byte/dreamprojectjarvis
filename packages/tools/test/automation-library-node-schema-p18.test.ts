// ---------------------------------------------------------------------------
// Phase 18, Stage 18.5 — the trusted n8n node schemas, this package's half.
//
// The schemas live in one place: the server holds the verified snapshot, core
// checks a draft's settings against it, and the draft's view carries a BOUNDED
// summary of it — the parameters a node really has, and the literal values the
// ones n8n requires may take. The tools are a translation onto that service,
// so this package's half is about what crosses the boundary:
//
//   • the tools carry the server's summary through unchanged, and never a whole
//     schema, an option list of any length or a bound;
//   • the tools' one-line answer says the server's own reason when a check
//     could not run — the tools never claim more than the server's checks do;
//   • the tools hold no schema of their own: there is no second copy of the
//     rules here, and no second path to n8n.
//
// The service is tested in apps/api, where the router and these tools are
// proven to answer alike. Named `automation-library*`, the slice CI runs for
// this package.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { type AutomationPlanningPort } from "@jarvis/core";
import { createAutomationPlanningTools } from "../src/tools/automation-planning-tools.js";

const DRAFT_ID = "draft-0001abcd";

const HINT = {
  nodeKey: "slack",
  type: "n8n-nodes-base.slack",
  label: "Slack",
  version: "2.4",
  parameterCount: 42,
  parameters: [{ name: "resource", type: "options", required: false, options: ["message", "file"] }],
};

const VIEW = {
  draftId: DRAFT_ID,
  title: "Leads",
  status: "unverified",
  version: { number: 2 },
  latestVersion: 2,
  requirements: [],
  checks: [{ id: "configuration_schema", status: "not_run", message: "Not run: no trusted n8n node schema is available to JARVIS, so the settings could not be checked against one." }],
  schema: [HINT],
};

function fakePort(view: Record<string, unknown> = VIEW) {
  return {
    match: vi.fn(async () => ({ ok: true as const, value: { explanation: "No suitable workflow found.", request: { openQuestions: [] } } })),
    createDraft: vi.fn(async () => ({ ok: true as const, value: { draft: view, existing: false } })),
    reviseDraft: vi.fn(async () => ({ ok: true as const, value: { draft: view, unchanged: false } })),
    getDraft: vi.fn(async () => ({ ok: true as const, value: view })),
    listDrafts: vi.fn(async () => ({ ok: true as const, value: { items: [], page: 1, limit: 20, total: 0, totalPages: 1 } })),
  } as unknown as AutomationPlanningPort & Record<keyof AutomationPlanningPort, ReturnType<typeof vi.fn>>;
}

const ctx = { userId: "u1", traceId: "t" };

describe("the tools and the node schemas", () => {
  it("carry the server's bounded summary through, unchanged", async () => {
    const [, , , get] = createAutomationPlanningTools(fakePort());
    const result = await get!.execute({ draftId: DRAFT_ID }, ctx);
    const draft = result.data as { schema: unknown };
    expect(draft.schema).toEqual([HINT]);
  });

  it("never carry a whole schema: the summary is names, types and values", async () => {
    const [, , , get] = createAutomationPlanningTools(fakePort());
    const result = await get!.execute({ draftId: DRAFT_ID }, ctx);
    const draft = result.data as { schema: Array<{ parameters: Array<Record<string, unknown>> }> };
    for (const hint of draft.schema) {
      for (const parameter of hint.parameters) {
        expect(Object.keys(parameter).sort()).toEqual(
          parameter.options === undefined ? ["name", "required", "type"] : ["name", "options", "required", "type"]
        );
      }
    }
    // The one-line answer carries the server's reason, never a dump.
    expect(result.metadata?.message).not.toMatch(/resource|parameterCount/);
  });

  it("say the server's own reason when a check could not run", async () => {
    const [, , revise] = createAutomationPlanningTools(fakePort());
    const result = await revise!.execute({ draftId: DRAFT_ID, baseVersion: 1, answers: { "question.x": "y" } }, ctx);
    expect(result.metadata?.message).toContain("Not run: no trusted n8n node schema is available to JARVIS");
  });

  it("say the server's reason even when the draft is otherwise fine", async () => {
    const passed = {
      ...VIEW,
      status: "validated",
      checks: [{ id: "configuration_schema", status: "passed", message: "Checked 1 setting against n8n-nodes-base 2.15.1's parameter schemas." }],
    };
    const [, , revise] = createAutomationPlanningTools(fakePort(passed));
    const result = await revise!.execute({ draftId: DRAFT_ID, baseVersion: 1, answers: { "question.x": "y" } }, ctx);
    expect(result.metadata?.message).toContain("Status: validated.");
  });
});

describe("this package holds no schema of its own", () => {
  const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sources(path));
      else if (entry.name.endsWith(".ts")) out.push(path);
    }
    return out;
  }

  it("no source file here imports the schema rules or the snapshot", () => {
    const offenders = sources(srcRoot).filter((file) => {
      const text = readFileSync(file, "utf8");
      return text.includes("automation-node-schema") || text.includes("N8N_NODE_SCHEMA_SNAPSHOT");
    });
    expect(offenders).toEqual([]);
  });

  it("the planning tools ask the service, and never n8n", () => {
    const text = readFileSync(join(srcRoot, "tools", "automation-planning-tools.ts"), "utf8");
    expect(text).toContain("AutomationPlanningPort");
    expect(text).not.toMatch(/fetch\(|axios|https?:\/\//);
  });
});
