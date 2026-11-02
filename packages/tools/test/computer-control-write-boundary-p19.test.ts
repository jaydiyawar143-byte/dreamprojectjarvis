// ---------------------------------------------------------------------------
// Phase 19, Stage 19.1 — a browser write runs only behind the executor.
//
// A browser write tool's `execute` is a public method and a ToolContext is a
// plain object. Before this stage a call with no `approvalId` journaled,
// claimed and ran the action, and a call with a caller-supplied `approvalId`
// was trusted to have come through the executor. An agent holding the raw
// registry, or any in-process caller, could reach the browser around the
// executor's permission check, its spoken-turn refusal, its shared-connection
// gate and its approval binding.
//
// Now the executor's checks are proved by a grant only the executor can give
// (execution-grant.ts): keyed by the exact context object it created, naming
// the tool, the user, the parameters' hash and the approval, and spent by its
// first read. This suite shows that:
//
//   * each of the six writes, called directly, is refused before the browser,
//     the journal, the scope resolver and the approval store are touched;
//   * a grant fits only the call it was issued for;
//   * through the executor, a missing, expired, replayed, mismatched or
//     cross-Organization approval fails closed, and a valid one runs once;
//   * a spoken turn neither runs a write nor spends its approval;
//   * the four reads are unchanged;
//   * the grant cannot be imported from outside the package.
//
// Fakes only: no browser, no network, no database. Named `computer-control*`,
// the slice CI runs for this package.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Approval,
  AuditLogger,
  BeginExecutionInput,
  BrowserRuntimePort,
  BrowserSessionPort,
  BrowserWriteScopePort,
  IApprovalConsumptionPort,
  IApprovalManager,
  IPermissionChecker,
  ITool,
  Role,
  ToolAccessGate,
  ToolContext,
  ToolExecutionRecord,
} from "@jarvis/core";
import { BROWSER_TOOL_IDS, VOICE_REFUSED_TOOLS, computeParamsHash } from "@jarvis/core";
import { MemoryExecutionJournal } from "../src/execution-journal.js";
import { issueExecutionGrant } from "../src/execution-grant.js";
import { ToolExecutor } from "../src/executor.js";
import { createBrowserTools } from "../src/tools/browser-tools.js";

const NOT_AUTHORIZED = "Browser actions run only after an approval is checked, so nothing was done.";
const USER = "owner-1";
const UPLOAD_ID = "11111111-1111-1111-1111-111111111111";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const identity = { url: "https://example.com/", title: "Example", status: 200 };

class Session implements BrowserSessionPort {
  actions: string[] = [];
  failWith: Error | null = null;
  private act(method: string) {
    this.actions.push(method);
    if (this.failWith) throw this.failWith;
  }
  async navigate(url: string) {
    return { ...identity, url, redirected: false };
  }
  async inspect() {
    return { ...identity, elements: [], truncated: false };
  }
  async extract() {
    return { ...identity, text: "page text", fields: {}, truncated: false };
  }
  async screenshot() {
    return { ...identity, screenshotId: "shot-1", byteSize: 1, format: "png" as const };
  }
  async click(selector: string) {
    this.act("click");
    return { ...identity, selector, navigated: false };
  }
  async type(selector: string) {
    this.act("type");
    return { ...identity, selector, navigated: false };
  }
  async select(selector: string) {
    this.act("select");
    return { ...identity, selector, navigated: false };
  }
  async submit(selector: string) {
    this.act("submit");
    return { ...identity, selector, navigated: true };
  }
  async download() {
    this.act("download");
    return { downloadId: UPLOAD_ID, fileName: "a.pdf", byteSize: 1, mimeType: "application/pdf", sourceOrigin: "https://example.com" };
  }
  async upload(selector: string, downloadId: string) {
    this.act("upload");
    return { ...identity, selector, downloadId, fileName: "a.pdf" };
  }
}

class Runtime implements BrowserRuntimePort {
  session = new Session();
  opened = 0;
  async withSession<T>(_userId: string, run: (session: BrowserSessionPort) => Promise<T>): Promise<T> {
    this.opened += 1;
    return run(this.session);
  }
  async shutdown() {}
}

/** Counts every journal row a write starts. */
class CountingJournal extends MemoryExecutionJournal {
  begins = 0;
  override async begin(input: BeginExecutionInput): Promise<ToolExecutionRecord> {
    this.begins += 1;
    return super.begin(input);
  }
}

const scope = (tenantId: string) => ({
  tenantId,
  providerId: "browser",
  connector: "service",
  requesterRoles: ["owner", "admin"] as Array<"owner" | "admin">,
  approverRoles: ["owner", "admin"] as Array<"owner" | "admin">,
});

interface Row {
  userId: string;
  toolId: string;
  params: Record<string, unknown>;
  paramsHash: string;
  expiresAt: number;
  tenantId: string;
  consumed: boolean;
}

/**
 * The approval store as the real one behaves (Phase 10.3 / Phase 17): an
 * approval is spent only when it exists, is unspent, unexpired, bound to this
 * user, tool and parameters, and belongs to the Organization the server just
 * resolved — and spending it claims the journal row in the same step.
 */
class Store implements IApprovalConsumptionPort {
  rows = new Map<string, Row>();
  consumeCalls = 0;
  constructor(private readonly journal: MemoryExecutionJournal) {}

  approve(id: string, toolId: string, params: Record<string, unknown>, extra: Partial<Row> = {}): void {
    this.rows.set(id, {
      userId: USER,
      toolId,
      params,
      paramsHash: computeParamsHash(params),
      expiresAt: Date.now() + 10 * 60 * 1000,
      tenantId: "org-1",
      consumed: false,
      ...extra,
    });
  }

  async consumeForExecution(input: Parameters<IApprovalConsumptionPort["consumeForExecution"]>[0]) {
    this.consumeCalls += 1;
    const row = this.rows.get(input.approvalId);
    if (!row) return { ok: false as const, reason: "not found" };
    if (row.consumed) return { ok: false as const, reason: "already consumed" };
    if (row.expiresAt <= Date.now()) return { ok: false as const, reason: "expired" };
    if (row.userId !== input.userId || row.toolId !== input.toolId) return { ok: false as const, reason: "not bound" };
    if (row.paramsHash !== input.paramsHash) return { ok: false as const, reason: "parameters changed" };
    if (!input.tenantScope || input.tenantScope.tenantId !== row.tenantId) {
      return { ok: false as const, reason: "organization changed" };
    }
    const claimed = await this.journal.claimForExecution(input.executionId, { ownerId: "store", leaseMs: 60_000 });
    if (!claimed) return { ok: false as const, reason: "execution not claimable" };
    row.consumed = true;
    return { ok: true as const };
  }
}

/**
 * What the executor reads approvals through. `stale` keeps reporting a spent
 * approval as approved — a cache or a race — so the store's own single-use
 * check is what is under test. `afterRead` runs after each read.
 */
function managerFor(store: Store, options: { stale?: boolean; afterRead?: () => void } = {}) {
  const list = (toolId: string, userId: string): Approval[] => {
    const found = [...store.rows.entries()]
      .filter(([, row]) => row.toolId === toolId && row.userId === userId)
      .map(([id, row]) => ({
        id,
        userId: row.userId,
        toolId: row.toolId,
        action: "execute",
        params: row.params,
        paramsHash: row.paramsHash,
        status: row.consumed && !options.stale ? ("consumed" as const) : ("approved" as const),
        expiresAt: new Date(row.expiresAt).toISOString(),
        createdAt: new Date().toISOString(),
      }));
    options.afterRead?.();
    return found;
  };
  const manager = {
    requestApproval: vi.fn(async (request: Omit<Approval, "id" | "status" | "createdAt">) => ({
      ...request,
      id: "apr-new",
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    })),
    findExistingForTool: vi.fn(async (toolId: string, userId: string) => list(toolId, userId)[0] ?? null),
    findApprovalsForTool: vi.fn(async (toolId: string, userId: string) => list(toolId, userId)),
  };
  return manager satisfies IApprovalManager;
}

const allowAll: IPermissionChecker = { hasPermission: () => true };
const audit = { log: async () => undefined } as unknown as AuditLogger;
const allowGate: ToolAccessGate = { check: async () => ({ allowed: true }) };

// ---------------------------------------------------------------------------
// The six writes, each with parameters and a changed copy of them.
// ---------------------------------------------------------------------------

const WRITES: Array<{ id: string; params: Record<string, unknown>; changed: Record<string, unknown> }> = [
  {
    id: BROWSER_TOOL_IDS.click,
    params: { url: "https://example.com/", selector: "#go" },
    changed: { url: "https://example.com/", selector: "#other" },
  },
  {
    id: BROWSER_TOOL_IDS.type,
    params: { url: "https://example.com/", selector: "#q", text: "Ada" },
    changed: { url: "https://example.com/", selector: "#q", text: "Eve" },
  },
  {
    id: BROWSER_TOOL_IDS.select,
    params: { url: "https://example.com/", selector: "#pick", value: "a" },
    changed: { url: "https://example.com/", selector: "#pick", value: "b" },
  },
  {
    id: BROWSER_TOOL_IDS.download,
    params: { url: "https://example.com/", selector: "#dl" },
    changed: { url: "https://example.com/", selector: "#other" },
  },
  {
    id: BROWSER_TOOL_IDS.submit,
    params: { url: "https://example.com/", selector: "#send", fields: { "#name": "Ada" } },
    changed: { url: "https://example.com/", selector: "#send", fields: { "#name": "Eve" } },
  },
  {
    id: BROWSER_TOOL_IDS.upload,
    params: { url: "https://example.com/", selector: "#file", downloadId: UPLOAD_ID },
    changed: { url: "https://example.com/", selector: "#file", downloadId: "22222222-2222-2222-2222-222222222222" },
  },
];

const READS: Array<[string, Record<string, unknown>]> = [
  [BROWSER_TOOL_IDS.navigate, { url: "https://example.com/" }],
  [BROWSER_TOOL_IDS.inspect, { url: "https://example.com/" }],
  [BROWSER_TOOL_IDS.extract, { url: "https://example.com/" }],
  [BROWSER_TOOL_IDS.screenshot, { url: "https://example.com/" }],
];

let runtime: Runtime;
let journal: CountingJournal;
let store: Store;
let scopeCalls: number;
let ownerTenant: string;
let access: BrowserWriteScopePort;
let tools: Map<string, ITool>;

beforeEach(() => {
  runtime = new Runtime();
  journal = new CountingJournal();
  store = new Store(journal);
  scopeCalls = 0;
  ownerTenant = "org-1";
  access = {
    async resolveWriteScope() {
      scopeCalls += 1;
      return { ok: true, tenantScope: scope(ownerTenant) };
    },
  };
  tools = new Map(createBrowserTools(runtime, journal, store, access).map((tool) => [tool.id, tool]));
});

const tool = (id: string): ITool => tools.get(id)!;

/** `gate: null` builds an executor that asks no shared-connection gate. */
function executor(manager: IApprovalManager, gate: ToolAccessGate | null = allowGate): ToolExecutor {
  return new ToolExecutor({ get: (id: string) => tools.get(id) }, allowAll, manager, audit, gate ? { accessGate: gate } : undefined);
}

function run(
  ex: ToolExecutor,
  toolId: string,
  params: Record<string, unknown>,
  extra: { approvalId?: string; inputMode?: "voice" | "text" } = {}
) {
  return ex.execute({ toolId, params, userId: USER, role: "owner" as Role, traceId: "trace-1", ...extra });
}

/** A context as the executor builds it, with the grant it would issue. */
function grantedContext(
  toolId: string,
  params: Record<string, unknown>,
  overrides: { approvalId?: string; grantUser?: string; grantApproval?: string; sharedAccessChecked?: boolean; inputMode?: "voice" | "text"; contextInputMode?: "voice" | "text" } = {}
): ToolContext {
  const approvalId = overrides.approvalId ?? "apr-1";
  const context: ToolContext = {
    userId: USER,
    traceId: "trace-1",
    approvalId,
    ...(overrides.contextInputMode ? { inputMode: overrides.contextInputMode } : {}),
  };
  issueExecutionGrant(context, {
    toolId,
    userId: overrides.grantUser ?? USER,
    paramsHash: computeParamsHash(params),
    approvalId: overrides.grantApproval ?? approvalId,
    ...(overrides.inputMode ? { inputMode: overrides.inputMode } : {}),
    sharedAccessChecked: overrides.sharedAccessChecked ?? true,
  });
  return context;
}

/** Nothing about the write was started: no browser, no journal row, no scope read, no approval spent. */
function expectNothingSpent(approvalId = "apr-1") {
  expect(runtime.opened).toBe(0);
  expect(runtime.session.actions).toEqual([]);
  expect(journal.begins).toBe(0);
  expect(scopeCalls).toBe(0);
  expect(store.consumeCalls).toBe(0);
  const row = store.rows.get(approvalId);
  if (row) expect(row.consumed).toBe(false);
}

// ---------------------------------------------------------------------------

describe("Phase 19.1 — a browser write called directly is refused before the browser", () => {
  it.each(WRITES)("$id with no approval at all", async ({ id, params }) => {
    store.approve("apr-1", id, params);

    const result = await tool(id).execute(params, { userId: USER, traceId: "trace-1" });

    expect(result).toMatchObject({ success: false, error: NOT_AUTHORIZED });
    expectNothingSpent();
  });

  it.each(WRITES)("$id with a caller-supplied id of a real, approved, bound approval", async ({ id, params }) => {
    // The store would accept this approval. The tool never asks it: an id in
    // the context is a claim, not proof that the executor checked anything.
    store.approve("apr-1", id, params);

    const result = await tool(id).execute(params, { userId: USER, traceId: "trace-1", approvalId: "apr-1" });

    expect(result).toMatchObject({ success: false, error: NOT_AUTHORIZED });
    expectNothingSpent();
  });

  it.each(WRITES)("$id with forged authorization fields in the context", async ({ id, params }) => {
    store.approve("apr-1", id, params);
    const forged = {
      userId: USER,
      traceId: "trace-1",
      approvalId: "apr-1",
      grant: { toolId: id, userId: USER, paramsHash: computeParamsHash(params), approvalId: "apr-1", sharedAccessChecked: true },
      executorAuthorized: true,
      sharedAccessChecked: true,
    } as ToolContext;

    const result = await tool(id).execute(params, forged);

    expect(result).toMatchObject({ success: false, error: NOT_AUTHORIZED });
    expectNothingSpent();
  });

  it.each(WRITES)("$id with a copy of a context the executor really authorized", async ({ id, params }) => {
    // A probe stands in for the tool inside a real executor, to capture the
    // context the executor hands over after its checks.
    store.approve("apr-1", id, params);
    let captured: ToolContext | undefined;
    const probe: ITool = {
      ...tool(id),
      id,
      validate: () => true,
      execute: async (_p, context) => {
        captured = context;
        return { success: true };
      },
    };
    const ex = new ToolExecutor({ get: () => probe }, allowAll, managerFor(store), audit, { accessGate: allowGate });
    expect((await run(ex, id, params, { approvalId: "apr-1" })).status).toBe("completed");
    expect(captured?.approvalId).toBe("apr-1");

    const result = await tool(id).execute(params, { ...captured! });

    expect(result).toMatchObject({ success: false, error: NOT_AUTHORIZED });
    expectNothingSpent();
  });
});

describe("Phase 19.1 — a grant fits only the call it was issued for", () => {
  const MISMATCHES: Array<[string, (id: string, params: Record<string, unknown>, changed: Record<string, unknown>) => { context: ToolContext; params: Record<string, unknown> }]> = [
    ["another tool", (id, params) => ({ context: grantedContext(id === BROWSER_TOOL_IDS.click ? BROWSER_TOOL_IDS.type : BROWSER_TOOL_IDS.click, params), params })],
    ["another user", (id, params) => ({ context: grantedContext(id, params, { grantUser: "intruder-1" }), params })],
    ["other parameters", (id, params, changed) => ({ context: grantedContext(id, params), params: changed })],
    ["another approval", (id, params) => ({ context: grantedContext(id, params, { grantApproval: "apr-other" }), params })],
    ["an executor that asked no shared-connection gate", (id, params) => ({ context: grantedContext(id, params, { sharedAccessChecked: false }), params })],
  ];

  const CASES = WRITES.flatMap((write) => MISMATCHES.map(([label, build]) => ({ ...write, label, build })));

  it.each(CASES)("$id refuses a grant for $label", async ({ id, params, changed, build }) => {
    store.approve("apr-1", id, params);
    store.approve("apr-1-changed", id, changed);
    const call = build(id, params, changed);

    const result = await tool(id).execute(call.params, call.context);

    expect(result).toMatchObject({ success: false, error: NOT_AUTHORIZED });
    expectNothingSpent();
  });

  it.each(WRITES)("$id spends a grant on its first use", async ({ id, params }) => {
    store.approve("apr-1", id, params);
    const context = grantedContext(id, params);

    const first = await tool(id).execute(params, context);
    expect(first.success, first.error).toBe(true);
    expect(store.consumeCalls).toBe(1);

    const again = await tool(id).execute(params, context);
    expect(again).toMatchObject({ success: false, error: NOT_AUTHORIZED });
    // Refused by the spent grant, before the journal or the store was asked.
    expect(store.consumeCalls).toBe(1);
    expect(journal.begins).toBe(1);
    expect(runtime.opened).toBe(1);
  });
});

describe("Phase 19.1 — through the executor: approvals fail closed, a valid one runs once", () => {
  it.each(WRITES)("$id runs once with an approved, unexpired, bound approval", async ({ id, params }) => {
    store.approve("apr-1", id, params);

    const result = await run(executor(managerFor(store)), id, params, { approvalId: "apr-1" });

    expect(result.status, result.error).toBe("completed");
    expect(store.consumeCalls).toBe(1);
    expect(store.rows.get("apr-1")!.consumed).toBe(true);
    expect(scopeCalls).toBe(1);
    expect(runtime.opened).toBe(1);
    // The tool's own action ran last (submit fills its fields first).
    expect(runtime.session.actions.at(-1)).toBe(id.slice("browser.".length));
  });

  it.each(WRITES)("$id with no approval asks for one and runs nothing", async ({ id, params }) => {
    const manager = managerFor(store);

    const result = await run(executor(manager), id, params);

    expect(result.status).toBe("approval_pending");
    expect(manager.requestApproval).toHaveBeenCalledTimes(1);
    expectNothingSpent();
  });

  it.each(WRITES)("$id with an expired approval runs nothing", async ({ id, params }) => {
    store.approve("apr-1", id, params, { expiresAt: Date.now() - 1000 });
    const manager = managerFor(store);

    const result = await run(executor(manager), id, params, { approvalId: "apr-1" });

    expect(result.status).toBe("approval_pending");
    expect(result.approvalId).not.toBe("apr-1");
    expectNothingSpent();
  });

  it.each(WRITES)("$id whose approval expires after the executor read it is refused by the store", async ({ id, params }) => {
    store.approve("apr-1", id, params);
    const manager = managerFor(store, {
      afterRead: () => {
        store.rows.get("apr-1")!.expiresAt = Date.now() - 1;
      },
    });

    const result = await run(executor(manager), id, params, { approvalId: "apr-1" });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("expired");
    expect(store.rows.get("apr-1")!.consumed).toBe(false);
    expect(runtime.opened).toBe(0);
  });

  it.each(WRITES)("$id cannot replay a spent approval", async ({ id, params }) => {
    store.approve("apr-1", id, params);
    const ex = executor(managerFor(store));
    expect((await run(ex, id, params, { approvalId: "apr-1" })).status).toBe("completed");

    const replay = await run(ex, id, params, { approvalId: "apr-1" });

    expect(replay.status).toBe("approval_pending");
    expect(replay.approvalId).not.toBe("apr-1");
    expect(store.consumeCalls).toBe(1);
    expect(runtime.opened).toBe(1);
  });

  it.each(WRITES)("$id cannot replay a spent approval even when the executor's read is stale", async ({ id, params }) => {
    // The first attempt fails before anything is sent, so its journal row is
    // retryable and only the store's single-use check stands in the way.
    store.approve("apr-1", id, params);
    const ex = executor(managerFor(store, { stale: true }));
    runtime.session.failWith = new Error("Action failed: no such element");
    expect((await run(ex, id, params, { approvalId: "apr-1" })).status).toBe("failed");
    expect(store.rows.get("apr-1")!.consumed).toBe(true);
    runtime.session.failWith = null;

    const replay = await run(ex, id, params, { approvalId: "apr-1" });

    expect(replay.status).toBe("failed");
    expect(replay.error).toContain("already consumed");
    expect(store.consumeCalls).toBe(2);
    expect(runtime.opened).toBe(1);
  });

  it.each(WRITES)("$id refuses an approval for other parameters", async ({ id, params, changed }) => {
    store.approve("apr-1", id, params);
    const manager = managerFor(store);

    const result = await run(executor(manager), id, changed, { approvalId: "apr-1" });

    expect(result.status).toBe("approval_pending");
    expect(result.approvalId).not.toBe("apr-1");
    expectNothingSpent();
  });

  it.each(WRITES)("$id refuses an approval from another Organization", async ({ id, params }) => {
    // The connection moved to org-2 after org-1 approved the write.
    store.approve("apr-1", id, params, { tenantId: "org-1" });
    ownerTenant = "org-2";

    const result = await run(executor(managerFor(store)), id, params, { approvalId: "apr-1" });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("organization changed");
    expect(store.rows.get("apr-1")!.consumed).toBe(false);
    expect(runtime.opened).toBe(0);
  });

  it.each(WRITES)("$id is refused to an outsider by the shared-connection gate", async ({ id, params }) => {
    store.approve("apr-1", id, params);
    const manager = managerFor(store);
    const deny: ToolAccessGate = { check: async () => ({ allowed: false, reason: "Browser control is not available to your account." }) };

    const result = await run(executor(manager, deny), id, params, { approvalId: "apr-1" });

    expect(result.status).toBe("permission_denied");
    expect(manager.requestApproval).not.toHaveBeenCalled();
    expectNothingSpent();
  });

  it.each(WRITES)("$id does not run under an executor with no shared-connection gate", async ({ id, params }) => {
    store.approve("apr-1", id, params);

    const result = await run(executor(managerFor(store), null), id, params, { approvalId: "apr-1" });

    expect(result.status).toBe("failed");
    expect(result.error).toBe(NOT_AUTHORIZED);
    expectNothingSpent();
  });
});

describe("Phase 19.1 — a spoken turn neither runs a browser write nor spends its approval", () => {
  it.each(WRITES)("$id through the executor", async ({ id, params }) => {
    store.approve("apr-1", id, params);
    const manager = managerFor(store);

    const result = await run(executor(manager), id, params, { approvalId: "apr-1", inputMode: "voice" });

    expect(result).toMatchObject({ status: "permission_denied", error: VOICE_REFUSED_TOOLS[id] });
    expect(manager.requestApproval).not.toHaveBeenCalled();
    expectNothingSpent();
  });

  it.each(WRITES)("$id even with a grant that says the turn was spoken", async ({ id, params }) => {
    store.approve("apr-1", id, params);

    const result = await tool(id).execute(params, grantedContext(id, params, { inputMode: "voice", contextInputMode: "voice" }));

    expect(result).toMatchObject({ success: false, error: VOICE_REFUSED_TOOLS[id] });
    expectNothingSpent();
  });

  it.each(WRITES)("$id when only the context says the turn was spoken", async ({ id, params }) => {
    store.approve("apr-1", id, params);

    const result = await tool(id).execute(params, grantedContext(id, params, { contextInputMode: "voice" }));

    expect(result).toMatchObject({ success: false, error: VOICE_REFUSED_TOOLS[id] });
    expectNothingSpent();
  });

  it.each(WRITES)("$id when only the grant says the turn was spoken", async ({ id, params }) => {
    store.approve("apr-1", id, params);

    const result = await tool(id).execute(params, grantedContext(id, params, { inputMode: "voice" }));

    expect(result).toMatchObject({ success: false, error: VOICE_REFUSED_TOOLS[id] });
    expectNothingSpent();
  });
});

describe("Phase 19.1 — the four reads are unchanged", () => {
  it.each(READS)("%s runs when called directly", async (id, params) => {
    const result = await tool(id).execute(params, { userId: USER, traceId: "trace-1" });
    expect(result.success, result.error).toBe(true);
    expect(runtime.opened).toBe(1);
    expect(journal.begins).toBe(0);
  });

  it.each(READS)("%s runs through the executor, spoken or typed, with or without a gate", async (id, params) => {
    const manager = managerFor(store);
    for (const ex of [executor(manager), executor(manager, null)]) {
      for (const inputMode of ["voice", "text"] as const) {
        expect((await run(ex, id, params, { inputMode })).status).toBe("completed");
      }
    }
    expect(runtime.opened).toBe(4);
    expect(manager.requestApproval).not.toHaveBeenCalled();
    expect(store.consumeCalls).toBe(0);
  });
});

describe("Phase 19.1 — the grant cannot be reached from outside the package", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const src = join(root, "src");
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []
    );
  const using = (name: string) =>
    files(src)
      .filter((file) => readFileSync(file, "utf8").includes(name))
      .map((file) => relative(src, file).split("\\").join("/"))
      .sort();

  it("the package exports only its index, and the index does not export the grant", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports: Record<string, unknown> };
    expect(Object.keys(manifest.exports)).toEqual(["."]);
    expect(readFileSync(join(src, "index.ts"), "utf8")).not.toContain("execution-grant");
  });

  it("only the executor issues a grant, and only the browser, desktop and Meta Ads writes verify one", () => {
    expect(using("issueExecutionGrant")).toEqual(["execution-grant.ts", "executor.ts"]);
    // A grant is read only through the full check, never taken bare.
    expect(using("takeExecutionGrant")).toEqual(["execution-grant.ts"]);
    expect(readFileSync(join(src, "execution-grant.ts"), "utf8")).not.toMatch(/export function takeExecutionGrant/);
    expect(using("verifyExecutionGrant")).toEqual([
      "execution-grant.ts",
      "tools/browser-tools.ts",
      "tools/desktop-tools.ts",
      "tools/meta-ads-write-tools.ts",
    ]);
  });

  it("pins the grant module byte-for-byte", () => {
    // A pin, not an aspiration, like the executor's (mcp-boundaries-s8): a
    // change to who may issue or read a grant, or to what a grant must match,
    // updates this digest deliberately, with the reason beside it.
    // Phase 19.1: issue (executor only) and verify (browser and Meta writes).
    const source = readFileSync(join(src, "execution-grant.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      "9d07ea7b9caecd38d0691c42792ef83a9c756b0dfa139b026239ba7174c493e2"
    );
  });
});
