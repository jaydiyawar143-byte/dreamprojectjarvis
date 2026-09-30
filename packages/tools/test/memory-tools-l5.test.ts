// S7.2 L5 — the memory tools.
//
//   memory.list        READ_ONLY — the user's own memories, as safe views
//   memory.forget      HIGH_IMPACT, approval-gated — fixed ids + versions only
//   memory.forget_all  HIGH_IMPACT, approval-gated — a fixed scope only
//
// The deleting tools reuse the Phase 10 machinery verbatim: a journal record,
// and an approval CONSUMED in the same durable step that claims it (user,
// tool, params hash, state, expiry). No approval, no deletion. The user is
// always the execution context's, never a parameter; no text ever names a
// target.
import { describe, it, expect } from "vitest";
import { computeParamsHash, MEMORY_FORGET_LIMIT, type ToolContext } from "@jarvis/core";
import { MemoryExecutionJournal, MemoryApprovalConsumer } from "../src/execution-journal.js";
import { createMemoryTools, type MemoryToolPort } from "../src/tools/memory-tools.js";

const V1 = "2026-09-01T10:00:00.000Z";
const V2 = "2026-09-02T10:00:00.000Z";

function port() {
  const calls: Array<[string, string, unknown]> = [];
  const memoryPort: MemoryToolPort = {
    async list(userId, options) {
      calls.push(["list", userId, options]);
      return { memories: [], total: 0, hasMore: false };
    },
    async forget(userId, targets) {
      calls.push(["forget", userId, targets]);
      return { status: "FORGOTTEN", deleted: targets.length, notFound: 0 };
    },
    async forgetAll(userId, scope) {
      calls.push(["forgetAll", userId, scope]);
      return { status: "FORGOTTEN", deleted: 3 };
    },
  };
  return { memoryPort, calls };
}

function setup(outcome?: Partial<MemoryToolPort>) {
  const { memoryPort, calls } = port();
  const journal = new MemoryExecutionJournal();
  const approvals = new MemoryApprovalConsumer(journal);
  const [list, forget, forgetAll] = createMemoryTools({ ...memoryPort, ...outcome }, journal, approvals);
  return { list: list!, forget: forget!, forgetAll: forgetAll!, calls, journal, approvals };
}

function approve(approvals: MemoryApprovalConsumer, toolId: string, params: Record<string, unknown>, over: Partial<{ userId: string; status: "approved" | "pending" | "rejected" | "consumed" }> = {}) {
  return approvals.create({
    userId: over.userId ?? "user-1",
    toolId,
    paramsHash: computeParamsHash(params),
    status: over.status ?? "approved",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ userId: "user-1", traceId: "trace-1", ...over });
const FORGET = { memoryIds: ["mem-1", "mem-2"], versions: [V1, V2] };

describe("L5 — what each memory tool is", () => {
  it("list is read-only; forget and forget_all are HIGH_IMPACT and approval-gated", () => {
    const { list, forget, forgetAll } = setup();
    expect([list.id, list.risk, list.requiresApproval]).toEqual(["memory.list", "READ_ONLY", false]);
    expect([forget.id, forget.risk, forget.requiresApproval]).toEqual(["memory.forget", "HIGH_IMPACT", true]);
    expect([forgetAll.id, forgetAll.risk, forgetAll.requiresApproval]).toEqual(["memory.forget_all", "HIGH_IMPACT", true]);
  });

  it("any role may manage its OWN memories: only 'read' is required", () => {
    const { list, forget, forgetAll } = setup();
    for (const tool of [list, forget, forgetAll]) expect(tool.requiredPermissions).toEqual(["read"]);
  });
});

describe("L5 — memory.forget accepts fixed ids and versions, and nothing else", () => {
  it("accepts ids with the versions they were shown at", () => {
    expect(setup().forget.validate(FORGET)).toBe(true);
  });

  it.each([
    ["text instead of an id", { memoryIds: ["short captions"], versions: [V1] }],
    ["a search phrase beside the ids", { ...FORGET, query: "captions" }],
    ["a user id", { ...FORGET, userId: "user-2" }],
    ["an extra key a pending-action modification could add", { ...FORGET, name: "x" }],
    ["no ids", { memoryIds: [], versions: [] }],
    ["versions that do not line up", { memoryIds: ["mem-1", "mem-2"], versions: [V1] }],
    ["the same id twice", { memoryIds: ["mem-1", "mem-1"], versions: [V1, V1] }],
    ["a version that is not a timestamp", { memoryIds: ["mem-1"], versions: ["latest"] }],
    ["a string instead of a list", { memoryIds: "mem-1", versions: V1 }],
    [`more than ${MEMORY_FORGET_LIMIT}`, { memoryIds: Array.from({ length: MEMORY_FORGET_LIMIT + 1 }, (_, i) => `mem-${i}`), versions: Array.from({ length: MEMORY_FORGET_LIMIT + 1 }, () => V1) }],
  ])("rejects %s", (_label, params) => {
    expect(setup().forget.validate(params as Record<string, unknown>)).toBe(false);
  });

  it("forget_all accepts exactly one fixed scope", () => {
    const { forgetAll } = setup();
    expect(forgetAll.validate({ scope: "ALL" })).toBe(true);
    expect(forgetAll.validate({ scope: "LEGACY" })).toBe(true);
    expect(forgetAll.validate({ scope: "EVERYTHING" })).toBe(false);
    expect(forgetAll.validate({ scope: "ALL", userId: "user-2" })).toBe(false);
    expect(forgetAll.validate({})).toBe(false);
  });

  it("list accepts only its two optional filters", () => {
    const { list } = setup();
    expect(list.validate({})).toBe(true);
    expect(list.validate({ includeExpired: true, limit: 10 })).toBe(true);
    expect(list.validate({ userId: "user-2" })).toBe(false);
    expect(list.validate({ limit: 500 })).toBe(false);
    expect(list.validate({ query: "captions" })).toBe(false);
  });
});

describe("L5 — no confirmed approval, no deletion", () => {
  it("without an approval in the context, nothing is deleted", async () => {
    const { forget, forgetAll, calls } = setup();
    expect(await forget.execute(FORGET, ctx())).toMatchObject({ success: false });
    expect(await forgetAll.execute({ scope: "ALL" }, ctx())).toMatchObject({ success: false });
    expect(calls).toEqual([]);
  });

  it("with a confirmed approval: consumed once, and the CONTEXT's user forgets the chosen ids", async () => {
    const { forget, calls, approvals, journal } = setup();
    const approval = approve(approvals, "memory.forget", FORGET);

    const result = await forget.execute(FORGET, ctx({ approvalId: approval.id }));

    expect(result).toMatchObject({ success: true, data: { forgotten: 2 } });
    expect(calls).toEqual([["forget", "user-1", [{ id: "mem-1", version: V1 }, { id: "mem-2", version: V2 }]]]);
    expect(approvals.get(approval.id)!.status).toBe("consumed");
    expect((await journal.listByUserTool("user-1", "memory.forget")).map((r) => r.status)).toEqual(["SUCCEEDED"]);
  });

  it("a consumed approval cannot delete twice", async () => {
    const { forget, calls, approvals } = setup();
    const approval = approve(approvals, "memory.forget", FORGET);
    await forget.execute(FORGET, ctx({ approvalId: approval.id }));
    const again = await forget.execute(FORGET, ctx({ approvalId: approval.id }));

    expect(again.success).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["issued for other parameters", (a: MemoryApprovalConsumer) => approve(a, "memory.forget", { memoryIds: ["mem-9"], versions: [V1] })],
    ["another user's", (a: MemoryApprovalConsumer) => approve(a, "memory.forget", FORGET, { userId: "user-2" })],
    ["still pending", (a: MemoryApprovalConsumer) => approve(a, "memory.forget", FORGET, { status: "pending" })],
    ["rejected", (a: MemoryApprovalConsumer) => approve(a, "memory.forget", FORGET, { status: "rejected" })],
    ["for another tool", (a: MemoryApprovalConsumer) => approve(a, "memory.forget_all", FORGET)],
  ])("an approval %s deletes nothing", async (_label, make) => {
    const { forget, calls, approvals } = setup();
    const approval = make(approvals);
    const result = await forget.execute(FORGET, ctx({ approvalId: approval.id }));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Approval denied/);
    expect(calls).toEqual([]);
  });

  it("with no way to verify approvals, it fails closed", async () => {
    const { memoryPort, calls } = port();
    const [, forget] = createMemoryTools(memoryPort, new MemoryExecutionJournal());
    const result = await forget!.execute(FORGET, ctx({ approvalId: "ap-1" }));
    expect(result.success).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a stale target reports that nothing was forgotten, in words with no memory content", async () => {
    const { forget, approvals, journal } = setup({
      async forget() {
        return { status: "STALE", deleted: 0, stale: 1 };
      },
    });
    const approval = approve(approvals, "memory.forget", FORGET);
    const result = await forget.execute(FORGET, ctx({ approvalId: approval.id }));

    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/changed/i);
    expect((await journal.listByUserTool("user-1", "memory.forget")).map((r) => r.status)).toEqual(["FAILED"]);
  });

  it("forget_all forgets the fixed scope for the context's user", async () => {
    const { forgetAll, calls, approvals } = setup();
    const approval = approve(approvals, "memory.forget_all", { scope: "LEGACY" });
    const result = await forgetAll.execute({ scope: "LEGACY" }, ctx({ approvalId: approval.id }));

    expect(result).toMatchObject({ success: true, data: { forgotten: 3, scope: "LEGACY" } });
    expect(calls).toEqual([["forgetAll", "user-1", "LEGACY"]]);
  });
});

describe("L5 — memory.list", () => {
  it("lists the context's user's memories — never a user named in a parameter", async () => {
    const { list, calls } = setup();
    const result = await list.execute({ limit: 5 }, ctx());
    expect(result.success).toBe(true);
    expect(calls).toEqual([["list", "user-1", { limit: 5, includeExpired: false }]]);
  });
});
