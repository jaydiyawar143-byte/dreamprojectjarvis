// ---------------------------------------------------------------------------
// Phase 18, Stage 18.2 — the workflow library's tools and the executor's voice
// refusal, in this package.
//
// The tools are translations onto `AutomationLibraryPort`; the service behind
// it is tested in apps/api, where the router and these tools are proven to
// answer alike. What is pinned here is this package's own half:
//   • the executor refuses a tool on the voice list for a spoken turn BEFORE
//     the tool runs — under the registry id and under any alias — and hands
//     every tool the turn's input mode;
//   • the sync tool refuses a spoken context itself, behind the executor;
//   • every tool refuses a server-only field and a bad value before the port
//     is asked, with the API's codes and sentences.
// Phase 18.3A adds this package's half of "a spoken turn never confirms": the
// executor never spends an approval for a spoken turn, and the integration
// tools hand the turn's mode to their service as its `voice` flag.
// Named `automation-library*`, the slice CI runs for this package.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_LIBRARY_TOOL_IDS,
  LIBRARY_INVALID_QUERY_MESSAGE,
  LIBRARY_INVALID_SYNC_MESSAGE,
  LIBRARY_SCOPE_REFUSED_MESSAGE,
  VOICE_CONFIRMATION_REFUSED_MESSAGE,
  VOICE_REFUSED_TOOLS,
  VOICE_TOOL_REFUSED_CODE,
  computeParamsHash,
  type Approval,
  type AuditLogger,
  type AutomationLibraryPort,
  type IApprovalManager,
  type IPermissionChecker,
  type ITool,
} from "@jarvis/core";
import { ToolExecutor } from "../src/executor.js";
import { createAutomationLibraryTools, SyncAutomationLibraryTool } from "../src/tools/automation-library-tools.js";
import { createIntegrationTools } from "../src/tools/integration-tools.js";

const { search: SEARCH, status: STATUS, sync: SYNC } = AUTOMATION_LIBRARY_TOOL_IDS;

function fakePort() {
  return {
    list: vi.fn(async () => ({ ok: true as const, value: { items: [], page: 1, limit: 50, total: 0, totalPages: 1 } })),
    status: vi.fn(async () => ({ ok: false as const, status: 403, code: "NOT_AVAILABLE", message: "n8n is not available to your account." })),
    startSync: vi.fn(async () => ({ ok: true as const, value: { mode: "run" as const, runId: "r", resumed: false, state: "running" as const } })),
    inspect: vi.fn(async () => ({ ok: false as const, status: 404, code: "ENTRY_NOT_FOUND", message: "No workflow with that id is in your organization's library." })),
    proposeAllowlist: vi.fn(async () => ({ ok: false as const, status: 403, code: "PERMISSION_DENIED", message: "no" })),
  } satisfies AutomationLibraryPort;
}

const allowAll: IPermissionChecker = { hasPermission: () => true };
const audit = { log: async () => undefined } as unknown as AuditLogger;

function setup() {
  const port = fakePort();
  const tools = new Map<string, ITool>(createAutomationLibraryTools(port).map((t) => [t.id, t]));
  const registry = { get: (id: string) => tools.get(id) ?? tools.get(id.replace(/-/g, ".")) };
  const executor = new ToolExecutor(registry, allowAll, {} as IApprovalManager, audit);
  const run = (toolId: string, params: Record<string, unknown>, inputMode?: "voice" | "text") =>
    executor.execute({ toolId, params, userId: "owner-1", role: "owner", traceId: "t", ...(inputMode ? { inputMode } : {}) });
  return { port, tools, executor, run };
}

describe("the executor refuses what speech may not start", () => {
  it("refuses a spoken sync before the tool runs, in the fixed sentence", async () => {
    const { port, tools, run } = setup();
    const execute = vi.spyOn(tools.get(SYNC)!, "execute");
    const refused = await run(SYNC, { continueUntilComplete: true }, "voice");
    expect(refused).toMatchObject({
      status: "permission_denied",
      error: VOICE_REFUSED_TOOLS[SYNC],
      result: { success: false, metadata: { code: VOICE_TOOL_REFUSED_CODE, status: 403, toolId: SYNC } },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(port.startSync).not.toHaveBeenCalled();
  });

  it("refuses it under an alias the registry resolves, by the registry's own id", async () => {
    const { port, run } = setup();
    expect(await run("automation-library-sync", {}, "voice")).toMatchObject({ status: "permission_denied", error: VOICE_REFUSED_TOOLS[SYNC] });
    expect(port.startSync).not.toHaveBeenCalled();
  });

  it("lets the same sync run typed, and the reads run spoken", async () => {
    const { port, run } = setup();
    expect((await run(SYNC, {}, "text")).status).toBe("completed");
    expect((await run(SYNC, {})).status).toBe("completed");
    expect(port.startSync).toHaveBeenCalledTimes(2);
    expect(port.startSync).toHaveBeenCalledWith("owner-1", { restart: false, continueUntilComplete: false, via: "jarvis" });
    expect((await run(SEARCH, { search: "x" }, "voice")).status).toBe("completed");
    expect((await run(STATUS, {}, "voice")).status).toBe("failed");
    expect(port.status).toHaveBeenCalledTimes(1);
  });

  it("hands the tool the turn's input mode, and nothing when there is none", async () => {
    const seen: unknown[] = [];
    const probe: ITool = {
      id: "probe",
      name: "probe",
      description: "probe",
      category: "system",
      risk: "READ_ONLY",
      parameters: [],
      requiresApproval: false,
      requiredPermissions: ["read"],
      version: "1",
      enabled: true,
      validate: () => true,
      execute: async (_params, ctx) => {
        seen.push("inputMode" in ctx ? ctx.inputMode : "absent");
        return { success: true };
      },
    };
    const executor = new ToolExecutor({ get: () => probe }, allowAll, {} as IApprovalManager, audit);
    await executor.execute({ toolId: "probe", params: {}, userId: "u", role: "owner", traceId: "t", inputMode: "voice" });
    await executor.execute({ toolId: "probe", params: {}, userId: "u", role: "owner", traceId: "t" });
    expect(seen).toEqual(["voice", "absent"]);
  });
});

describe("the tools", () => {
  it("refuse a spoken context themselves, behind the executor", async () => {
    const port = fakePort();
    const refused = await new SyncAutomationLibraryTool(port).execute({}, { userId: "owner-1", inputMode: "voice" });
    expect(refused).toMatchObject({ success: false, error: VOICE_REFUSED_TOOLS[SYNC], metadata: { code: VOICE_TOOL_REFUSED_CODE, status: 403 } });
    expect(port.startSync).not.toHaveBeenCalled();
  });

  it("refuse a server-only field and a bad value before the port is asked, as the API does", async () => {
    const { port, run } = setup();
    const scoped = { status: 400, code: "REQUEST_SCOPE_REFUSED" };
    expect((await run(SEARCH, { organizationId: "org-x" })).result).toMatchObject({ error: LIBRARY_SCOPE_REFUSED_MESSAGE, metadata: scoped });
    expect((await run(STATUS, { tenant_id: "org-x" })).result).toMatchObject({ metadata: scoped });
    expect((await run(SYNC, { cursor: "eyJ" })).result).toMatchObject({ metadata: scoped });
    expect((await run(SEARCH, { limit: 1000 })).result).toMatchObject({ error: LIBRARY_INVALID_QUERY_MESSAGE, metadata: { status: 400, code: "INVALID_QUERY" } });
    expect((await run(SYNC, { restart: "true" })).result).toMatchObject({ error: LIBRARY_INVALID_SYNC_MESSAGE, metadata: { status: 400, code: "INVALID_REQUEST" } });
    expect((await run(SYNC, { idempotencyKey: "no" })).result).toMatchObject({ metadata: { code: "INVALID_REQUEST" } });
    expect(port.list).not.toHaveBeenCalled();
    expect(port.status).not.toHaveBeenCalled();
    expect(port.startSync).not.toHaveBeenCalled();
  });

  it("pass the port's refusal through with its status, code and sentence", async () => {
    const { run } = setup();
    expect((await run(STATUS, {})).result).toEqual({
      success: false,
      error: "n8n is not available to your account.",
      metadata: { toolId: STATUS, code: "NOT_AVAILABLE", status: 403 },
    });
  });

  it("forward exactly the validated query and options, and the caller from the context", async () => {
    const { port, run } = setup();
    await run(SEARCH, { search: " invoice ", active: false, presence: "missing", page: 2, limit: 10 });
    expect(port.list).toHaveBeenCalledWith("owner-1", { page: 2, limit: 10, search: "invoice", active: false, presence: "missing" });
    await run(SYNC, { continueUntilComplete: true, restart: true, idempotencyKey: "abcdefgh-1" });
    expect(port.startSync).toHaveBeenLastCalledWith("owner-1", { restart: true, continueUntilComplete: true, idempotencyKey: "abcdefgh-1", via: "jarvis" });
  });
});

describe("Phase 18.3A — a spoken turn never spends an approval", () => {
  const PARAMS = { to: "+910000000000", body: "hi" };
  function setupGated(approved: boolean) {
    const ran: unknown[] = [];
    const tool: ITool = {
      id: "whatsapp.send",
      name: "send",
      description: "send",
      category: "communication",
      risk: "EXTERNAL_SIDE_EFFECT",
      parameters: [],
      requiresApproval: true,
      requiredPermissions: ["read", "write"],
      version: "1",
      enabled: true,
      validate: () => true,
      execute: async (params, ctx) => {
        ran.push({ params, approvalId: ctx.approvalId });
        return { success: true };
      },
    };
    const rows: Approval[] = approved
      ? [
          {
            id: "apr-1",
            userId: "owner-1",
            toolId: tool.id,
            action: "execute",
            params: PARAMS,
            paramsHash: computeParamsHash(PARAMS),
            status: "approved",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            createdAt: new Date().toISOString(),
          } as Approval,
        ]
      : [];
    const manager: IApprovalManager = {
      requestApproval: vi.fn(async (r) => ({ ...r, id: "apr-new", status: "pending", createdAt: new Date().toISOString() }) as Approval),
      findExistingForTool: async () => rows[0] ?? null,
      findApprovalsForTool: async () => rows,
    };
    const executor = new ToolExecutor({ get: () => tool }, allowAll, manager, audit);
    const run = (inputMode?: "voice" | "text", approvalId?: string) =>
      executor.execute({
        toolId: tool.id,
        params: PARAMS,
        userId: "owner-1",
        role: "owner",
        traceId: "t",
        ...(approvalId ? { approvalId } : {}),
        ...(inputMode ? { inputMode } : {}),
      });
    return { run, ran, manager };
  }

  it("refuses to spend an approved approval for a spoken turn — with its id or found by parameters", async () => {
    const h = setupGated(true);
    for (const approvalId of ["apr-1", undefined]) {
      expect(await h.run("voice", approvalId)).toMatchObject({
        status: "permission_denied",
        error: VOICE_CONFIRMATION_REFUSED_MESSAGE,
        result: { metadata: { code: VOICE_TOOL_REFUSED_CODE, status: 403 } },
      });
    }
    expect(h.ran).toEqual([]);
  });

  it("lets a spoken turn ask, and runs a typed one", async () => {
    const asking = setupGated(false);
    expect((await asking.run("voice")).status).toBe("approval_pending");
    expect(asking.manager.requestApproval).toHaveBeenCalledTimes(1);
    const typed = setupGated(true);
    expect((await typed.run(undefined, "apr-1")).status).toBe("completed");
    expect(typed.ran).toEqual([{ params: PARAMS, approvalId: "apr-1" }]);
  });

  it("hands an integration tool's service the turn's mode as its voice flag, and nothing for a typed turn", async () => {
    const execute = vi.fn(async () => ({ ok: false as const, command: "disconnect" as const, integration: "google" as const, code: "CONFIRMATION_REQUIRED" as const, message: "no" }));
    const tools = new Map(createIntegrationTools({ execute } as never).map((t) => [t.id, t]));
    await tools.get("integration.disconnect")!.execute({ integration: "google" }, { userId: "u", inputMode: "voice" });
    await tools.get("integration.test")!.execute({ integration: "google" }, { userId: "u", inputMode: "voice" });
    await tools.get("integration.disconnect")!.execute({ integration: "google" }, { userId: "u" });
    const contexts = execute.mock.calls.map((call) => (call as unknown[])[1] as Record<string, unknown>);
    expect(contexts[0]).toMatchObject({ source: "jarvis", voice: true });
    expect(contexts[1]).toMatchObject({ voice: true });
    expect(contexts[2]).not.toHaveProperty("voice");
  });
});
