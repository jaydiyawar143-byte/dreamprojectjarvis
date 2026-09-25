// ---------------------------------------------------------------------------
// S6 — Objective evaluation, drift guard (T37).
//
// The S6 evaluator (packages/core) decides which provider row corroborates a
// tool's reported success. It cannot import the tools — core sits below them
// — so it names them in fixed maps. This file is where those maps are checked
// against the tools that actually exist, so a renamed tool or a changed
// command fails a test instead of silently turning an evaluation to
// NOT_EVALUABLE (or worse, to a wrong EVIDENCED).
//
// Nothing here executes a provider: every port is a recorder.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  GOOGLE_TASK_ACTIONS,
  GOOGLE_WRITE_ACTIONS,
  INTEGRATION_TOOL_COMMAND,
  TASK_STORE_WRITE_TOOLS,
  type IntegrationCommandResult,
} from "@jarvis/core";
import { createIntegrationTools, INTEGRATION_TOOL_IDS } from "../src/tools/integration-tools.js";
import { createGoogleWorkspaceTools } from "../src/tools/google-workspace-tools.js";
import { createGoogleWriteTools } from "../src/tools/google-write-tools.js";
import { createTaskTools } from "../src/tools/task-tools.js";

describe("T37 — the S6 corroboration maps match the real tools", () => {
  it("every integration tool sends exactly the command the evaluator expects", async () => {
    const sent: Array<{ toolId: string; command: string }> = [];
    let current = "";
    const port = {
      async execute(input: { command: string; integration?: string | null }): Promise<IntegrationCommandResult> {
        sent.push({ toolId: current, command: input.command });
        return {
          ok: true,
          command: input.command,
          integration: null,
          data: {},
          message: "ok",
          at: "2026-09-25T00:00:00.000Z",
        } as IntegrationCommandResult;
      },
    };

    for (const tool of createIntegrationTools(port as never)) {
      current = tool.id;
      await tool.execute({ integration: "meta", config: { accountId: "act_1" } }, { userId: "user-1", traceId: "t" });
    }

    expect(sent.map((s) => s.toolId).sort()).toEqual([...INTEGRATION_TOOL_IDS].sort());
    for (const { toolId, command } of sent) {
      expect(INTEGRATION_TOOL_COMMAND[toolId], toolId).toBe(command);
    }
    expect(Object.keys(INTEGRATION_TOOL_COMMAND).sort()).toEqual([...INTEGRATION_TOOL_IDS].sort());
  });

  it("every Google read tool is one of GOOGLE_TASK_ACTIONS, and read-only", () => {
    const tools = createGoogleWorkspaceTools({} as never);
    expect(tools.map((t) => t.id).sort()).toEqual([...GOOGLE_TASK_ACTIONS].sort());
    for (const tool of tools) expect(tool.risk, tool.id).toBe("READ_ONLY");
  });

  it("every Google planner is google.plan.<one of GOOGLE_WRITE_ACTIONS>", () => {
    const tools = createGoogleWriteTools({} as never);
    expect(tools.map((t) => t.id).sort()).toEqual(GOOGLE_WRITE_ACTIONS.map((a) => `google.plan.${a}`).sort());
  });

  it("the task-store writes the evaluator trusts are exactly the non-read-only task tools", () => {
    const writes = createTaskTools({} as never)
      .filter((t) => t.risk !== "READ_ONLY")
      .map((t) => t.id)
      .sort();
    expect([...TASK_STORE_WRITE_TOOLS].sort()).toEqual(writes);
  });
});
