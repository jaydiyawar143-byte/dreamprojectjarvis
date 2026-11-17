// ---------------------------------------------------------------------------
// UEE-0 — what the audit trail would keep of a sandbox command.
//
// The question: if a tool carrying shell commands or code ran through
// ToolExecutor today, what would land in the audit row? There is no such tool —
// the sandbox is built and not exposed (sandbox-import-boundary-uee0) — so this
// drives the REAL executor and the REAL audit logger with a stand-in tool that
// exists only in this file and is registered nowhere.
//
// THE FINDING, as the code stands (packages/tools/src/executor.ts `audit()`,
// packages/security/src/audit.ts `AuditLogger.log`):
//
//   - The executor writes `parameters: request.params` — all of it.
//   - The logger redacts it BEFORE it is stored or printed, in two passes:
//       by KEY    a fixed list of names (`password`, `apiKey`, `token`, `secret`…),
//                 at any depth;
//       by SHAPE  values that LOOK like a secret (`sk-…`, `Bearer …`, a JWT,
//                 `token=…`, `password=…`, `api_key=…`).
//   - Only the Phase 19 browser and desktop tools get a tool-aware, value-free
//     projection (`computerControlValueFreeParams`). A sandbox tool would not.
//
// SO: a credential-shaped value inside a command is redacted — and an ordinary
// command, a script, and an environment value under an ordinary name are stored
// VERBATIM, in the audit row and in the console line. `N8nSandboxService` is
// careful never to log them; the executor, a layer above it, would.
//
// WHAT UEE-0 DOES AND DOES NOT DO ABOUT IT. Closing this needs a change to the
// shared audit contract (a projection for the sandbox tool ids, as Phase 19.1
// did for the browser) — a runtime change, so it is NOT made here. This file:
//   1. pins what IS protected, so a regression there is caught;
//   2. pins the gap as a CHARACTERIZATION, named KNOWN GAP, so it cannot be
//      forgotten and cannot be fixed without someone flipping a test on purpose;
//   3. does nothing that makes the gap reachable — no sandbox tool exists, and
//      the boundary tests keep it that way.
// The sandbox tool must not be added before the gap is closed. See the report.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computerControlValueFreeParams } from "@jarvis/core";
import type { AuditEntry, IApprovalManager, IAuditRepository, ITool } from "@jarvis/core";
import { ToolExecutor } from "@jarvis/tools";
import { AuditLogger, redactAuditParams } from "@jarvis/security";

// ---------------------------------------------------------------------------
// A stand-in for a tool that takes a shell command. Test-local. Never registered.
// ---------------------------------------------------------------------------

const TOOL_ID = "sandbox.exec";

function standInTool(overrides: Partial<ITool> = {}): ITool {
  return {
    id: TOOL_ID,
    name: "Stand-in sandbox command",
    description: "Test-only. Not a tool of this deployment.",
    category: "integration",
    risk: "EXTERNAL_SIDE_EFFECT",
    parameters: [],
    requiresApproval: false,
    requiredPermissions: ["read"],
    version: "0.0.0",
    enabled: true,
    validate: () => true,
    execute: async () => ({ success: true, data: { ran: true } }),
    ...overrides,
  };
}

type Row = Omit<AuditEntry, "id" | "timestamp">;

interface Harness {
  rows: Row[];
  consoleLines: Record<string, unknown>[];
  approvalRequests: Array<{ params: Record<string, unknown> }>;
  run: (params: Record<string, unknown>, options?: { allowed?: boolean; tool?: ITool }) => Promise<void>;
}

function harness(): Harness {
  const rows: Row[] = [];
  const approvalRequests: Array<{ params: Record<string, unknown> }> = [];
  const repository: IAuditRepository = {
    create: async (entry) => {
      rows.push(entry);
      return { ...entry, id: `audit-${rows.length}`, timestamp: new Date() };
    },
    query: async () => [],
  };
  // The real logger: the same class the container builds around the real repository.
  const logger = new AuditLogger(repository);
  const approvals: IApprovalManager = {
    requestApproval: async (request) => {
      approvalRequests.push({ params: request.params as Record<string, unknown> });
      return { id: "approval-1" } as never;
    },
    findExistingForTool: async () => null,
    findApprovalsForTool: async () => [],
  };
  const consoleLines: Record<string, unknown>[] = [];
  return {
    rows,
    consoleLines,
    approvalRequests,
    async run(params, options = {}) {
      const tool = options.tool ?? standInTool();
      const executor = new ToolExecutor(
        { get: (id) => (id === tool.id ? tool : undefined) },
        { hasPermission: () => options.allowed !== false },
        approvals,
        logger
      );
      await executor.execute({
        toolId: tool.id,
        params,
        userId: "user-1",
        role: "member" as never,
        traceId: "trace-1",
      });
    },
  };
}

// The AuditLogger also prints a JSON line to the console: a second place the
// parameters come to rest (a deployment's log). Captured, so it is held to the
// same standard as the row.
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  output = vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => output.mockRestore());

function printed(): Record<string, unknown>[] {
  return output.mock.calls.flatMap((call: unknown[]) => {
    try {
      return [JSON.parse(String(call[0])) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

const FIRST = (h: Harness): Row => {
  expect(h.rows).toHaveLength(1);
  return h.rows[0]!;
};

// ---------------------------------------------------------------------------
// 1. What the real executor and the real logger do
// ---------------------------------------------------------------------------

describe("a command-carrying tool, through the real ToolExecutor and the real AuditLogger", () => {
  it("is audited once, with its parameters, by the executor", async () => {
    const h = harness();
    await h.run({ command: "echo hello" });

    const row = FIRST(h);
    expect(row.action).toBe("tool.execute");
    expect(row.toolId).toBe(TOOL_ID);
    expect(row.result).toBe("success");
    // The executor hands the logger the request's parameters whole.
    expect(row.parameters).toBeDefined();
  });

  describe("what IS protected today", () => {
    it("redacts a credential-shaped value inside the command text", async () => {
      const h = harness();
      await h.run({
        command:
          'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789" https://api.example.com ' +
          "&& export TOKEN=abc123xyz && echo sk-abcdefghijklmnop1234",
      });

      const stored = JSON.stringify(FIRST(h).parameters);
      expect(stored).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
      expect(stored).not.toContain("abc123xyz");
      expect(stored).not.toContain("sk-abcdefghijklmnop1234");
      expect(stored).toContain("[REDACTED]");
    });

    it("redacts a value held under a credential-named key, at any depth", async () => {
      const h = harness();
      await h.run({
        command: "run",
        env: { apiKey: "plain-api-key-value", nested: { password: "plain-password-value", deeper: { secret: "plain-secret-value" } } },
      });

      const stored = JSON.stringify(FIRST(h).parameters);
      for (const value of ["plain-api-key-value", "plain-password-value", "plain-secret-value"]) expect(stored).not.toContain(value);
    });

    it("redacts the same way for a call the executor refuses, so a refusal leaves no more than a success", async () => {
      const h = harness();
      await h.run({ command: "export TOKEN=abc123xyz" }, { allowed: false });

      const row = FIRST(h);
      expect(row.result).toBe("rejected");
      expect(JSON.stringify(row.parameters)).not.toContain("abc123xyz");
    });

    it("holds the console line to the same standard as the row", async () => {
      const h = harness();
      await h.run({ command: "export TOKEN=abc123xyz", env: { apiKey: "plain-api-key-value" } });

      const line = printed().find((entry) => entry.event === "tool.execute");
      expect(line, "the logger prints one line per row").toBeDefined();
      expect(line!.parameters).toEqual(FIRST(h).parameters);
      expect(JSON.stringify(line)).not.toContain("abc123xyz");
      expect(JSON.stringify(line)).not.toContain("plain-api-key-value");
    });
  });

  describe("KNOWN GAP — what is NOT protected (UEE-5 prerequisite; do not add a sandbox tool before it is closed)", () => {
    // These assertions describe today's behaviour, and the behaviour is the
    // problem. They are expected to be INVERTED by the change that gives the
    // sandbox tool ids a value-free projection in the audit contract (as
    // `computerControlValueFreeParams` does for browser and desktop actions).
    // Until then, they are the proof that the gap exists and where it is.
    const COMMAND = "python -c \"print(open('/data/customers.csv').read())\"";
    const CODE = "import pandas as pd\nprint(df['email'].tolist())";
    const PARAMS = { command: COMMAND, code: CODE, env: { DB_PASS: "plain-db-pass-9", MY_SECRET: "plain-my-secret-7" } };

    it("stores an ordinary command and script verbatim in the audit row", async () => {
      const h = harness();
      await h.run(PARAMS);

      const stored = FIRST(h).parameters as Record<string, unknown>;
      expect(stored.command).toBe(COMMAND);
      expect(stored.code).toBe(CODE);
    });

    it("stores an environment value verbatim when its name is not on the credential list", async () => {
      const h = harness();
      await h.run(PARAMS);

      const env = (FIRST(h).parameters as { env: Record<string, unknown> }).env;
      expect(env.DB_PASS).toBe("plain-db-pass-9");
      expect(env.MY_SECRET).toBe("plain-my-secret-7");
    });

    it("prints the same text on the console line", async () => {
      const h = harness();
      await h.run(PARAMS);

      const line = JSON.stringify(printed().find((entry) => entry.event === "tool.execute"));
      expect(line).toContain("customers.csv");
      expect(line).toContain("plain-db-pass-9");
    });

    it("has no tool-aware projection for a sandbox tool id: the generic redaction is all there is", () => {
      expect(computerControlValueFreeParams(TOOL_ID, PARAMS)).toBeNull();
      expect(computerControlValueFreeParams("sandbox.run", PARAMS)).toBeNull();
      expect(redactAuditParams(PARAMS, TOOL_ID)).toEqual(redactAuditParams(PARAMS));
    });

    it("is closed for the Phase 19 desktop tool, which shows the mechanism exists and what a sandbox tool needs", () => {
      const typed = "words the owner typed that must not rest in the audit trail";
      const stored = JSON.stringify(redactAuditParams({ text: typed, summary: "x" }, "desktop.input.type"));
      expect(stored).not.toContain(typed);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. The approval record, the other place parameters rest
// ---------------------------------------------------------------------------

describe("the approval a sandbox call would need", () => {
  it("is requested by the executor with the exact parameters, in the clear", async () => {
    // Needed so an approver can see exactly what would run — and the reason a
    // sandbox tool needs SEALED approval parameters, as Phase 19.5 did for the
    // browser (`ApprovalSealedParams`), before it is added: today a non-browser
    // tool's approval holds its parameters as written.
    const h = harness();
    const params = { command: "python -c \"print(open('/data/customers.csv').read())\"", env: { DB_PASS: "plain-db-pass-9" } };

    await h.run(params, { tool: standInTool({ requiresApproval: true }) });

    expect(h.approvalRequests).toHaveLength(1);
    expect(h.approvalRequests[0]!.params).toEqual(params);
    // The audit row for the pending call is the redacted one: the row and the
    // approval are different stores with different rules.
    const row = FIRST(h);
    expect(row.result).toBe("pending");
  });
});
