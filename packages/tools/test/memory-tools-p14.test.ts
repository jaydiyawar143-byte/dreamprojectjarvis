// Phase 14 — the two new memory tools, and the scope of memory.list.
//
//   memory.correct        HIGH_IMPACT, approval-gated — one memory id at the
//                         version the user was shown, and the id of the saved
//                         USER message holding the new value. Never the value.
//   memory.purge_expired  LOW_IMPACT — no parameters; the calling user's
//                         long-expired memories. Run by the retention sweep.
//
// Neither is on any agent's allowlist (asserted with the agent policy, in
// packages/agents). memory.correct reuses the Phase 10 machinery exactly as
// memory.forget does: a journal record, and an approval consumed in the same
// durable step that claims it.
import { describe, it, expect } from "vitest";
import { computeParamsHash, MEMORY_CORRECT_TOOL_ID, MEMORY_PURGE_TOOL_ID, type MemoryCorrectionStatus, type ToolContext } from "@jarvis/core";
import { MemoryExecutionJournal, MemoryApprovalConsumer } from "../src/execution-journal.js";
import { createMemoryCorrectionTool, createMemoryRetentionTool, createMemoryTools, type MemoryToolPort } from "../src/tools/memory-tools.js";

const V1 = "2026-09-01T10:00:00.000Z";
const CORRECT = { memoryId: "mem-1", version: V1, sourceMessageId: "msg-9" };

function port(over: Partial<MemoryToolPort> = {}) {
  const calls: Array<[string, string, unknown]> = [];
  const memoryPort: MemoryToolPort = {
    async list(userId, options) {
      calls.push(["list", userId, options]);
      return { memories: [], total: 0, hasMore: false };
    },
    async forget() {
      return { status: "FORGOTTEN", deleted: 1, notFound: 0 };
    },
    async forgetAll() {
      return { status: "FORGOTTEN", deleted: 1 };
    },
    async correct(userId, target, context) {
      calls.push(["correct", userId, { target, context }]);
      return { status: "CORRECTED" };
    },
    async purgeExpired(userId) {
      calls.push(["purgeExpired", userId, null]);
      return 4;
    },
    ...over,
  };
  return { memoryPort, calls };
}

function setup(over: Partial<MemoryToolPort> = {}) {
  const { memoryPort, calls } = port(over);
  const journal = new MemoryExecutionJournal();
  const approvals = new MemoryApprovalConsumer(journal);
  return {
    correct: createMemoryCorrectionTool(memoryPort, journal, approvals),
    purge: createMemoryRetentionTool(memoryPort),
    list: createMemoryTools(memoryPort, journal, approvals)[0]!,
    calls,
    journal,
    approvals,
  };
}

function approve(approvals: MemoryApprovalConsumer, params: Record<string, unknown>, over: Partial<{ userId: string; toolId: string; status: "approved" | "pending" | "rejected" | "consumed" }> = {}) {
  return approvals.create({
    userId: over.userId ?? "user-1",
    toolId: over.toolId ?? MEMORY_CORRECT_TOOL_ID,
    paramsHash: computeParamsHash(params),
    status: over.status ?? "approved",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ userId: "user-1", traceId: "trace-1", ...over });

// ---------------------------------------------------------------------------

describe("Phase 14 — what the new memory tools are", () => {
  it("memory.correct is HIGH_IMPACT and approval-gated, like forgetting", () => {
    const { correct } = setup();
    expect([correct.id, correct.risk, correct.requiresApproval, correct.requiredPermissions]).toEqual(["memory.correct", "HIGH_IMPACT", true, ["read"]]);
  });

  it("memory.purge_expired is LOW_IMPACT and needs no approval: the retention policy is its authority", () => {
    const { purge } = setup();
    expect([purge.id, purge.risk, purge.requiresApproval, purge.requiredPermissions]).toEqual(["memory.purge_expired", "LOW_IMPACT", false, ["read"]]);
    expect(purge.parameters).toEqual([]);
  });

  it("the three L5 tools are still exactly three, in the same order", () => {
    const { memoryPort } = port();
    expect(createMemoryTools(memoryPort, new MemoryExecutionJournal()).map((t) => t.id)).toEqual(["memory.list", "memory.forget", "memory.forget_all"]);
  });
});

describe("Phase 14 — memory.correct takes ids and a version, never words", () => {
  it("accepts a memory id, its version and a source message id", () => {
    expect(setup().correct.validate(CORRECT)).toBe(true);
  });

  it.each([
    ["the new value as a parameter", { ...CORRECT, statement: "I prefer light mode" }],
    ["memory content as a parameter", { ...CORRECT, content: "I prefer light mode" }],
    ["a user id", { ...CORRECT, userId: "user-2" }],
    ["a project id", { ...CORRECT, projectId: "proj-1" }],
    ["no source message", { memoryId: "mem-1", version: V1 }],
    ["no version", { memoryId: "mem-1", sourceMessageId: "msg-9" }],
    ["a version that is not a timestamp", { ...CORRECT, version: "latest" }],
    ["a memory id that is text", { ...CORRECT, memoryId: "the one about dark mode" }],
    ["a list of memories", { ...CORRECT, memoryId: ["mem-1", "mem-2"] }],
    ["a source that is text", { ...CORRECT, sourceMessageId: "I prefer light mode" }],
    ["nothing", {}],
  ])("refuses %s", (_name, params) => {
    expect(setup().correct.validate(params as Record<string, unknown>)).toBe(false);
  });
});

describe("Phase 14 — memory.correct runs only with a consumed approval", () => {
  it("corrects for the calling user, passing ids only, and consumes the approval", async () => {
    const { correct, calls, approvals, journal } = setup();
    const approval = approve(approvals, CORRECT);

    const result = await correct.execute(CORRECT, ctx({ approvalId: approval.id }));

    expect(result).toMatchObject({ success: true, data: { corrected: 1 } });
    expect(calls).toEqual([["correct", "user-1", { target: { id: "mem-1", version: V1, sourceMessageId: "msg-9" }, context: { traceId: "trace-1" } }]]);
    expect(approvals.get(approval.id)!.status).toBe("consumed");
    expect((await journal.listByUserTool("user-1", "memory.correct")).map((r) => r.status)).toEqual(["SUCCEEDED"]);
  });

  it("refuses without an approval, and the port is never called", async () => {
    const { correct, calls } = setup();
    const result = await correct.execute(CORRECT, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/confirmation/i);
    expect(calls).toEqual([]);
  });

  it.each([
    ["someone else's approval", { userId: "user-2" }],
    ["an approval for another tool", { toolId: "memory.forget" }],
    ["an approval that was not granted", { status: "pending" as const }],
    ["a rejected approval", { status: "rejected" as const }],
    ["an approval already used", { status: "consumed" as const }],
  ])("refuses %s", async (_name, over) => {
    const { correct, calls, approvals } = setup();
    const approval = approve(approvals, CORRECT, over);
    const result = await correct.execute(CORRECT, ctx({ approvalId: approval.id }));
    expect(result.success).toBe(false);
    expect(calls).toEqual([]);
  });

  it("an approval for one memory cannot correct another: the parameters are bound to it", async () => {
    const { correct, calls, approvals } = setup();
    const approval = approve(approvals, CORRECT);
    for (const tampered of [{ ...CORRECT, memoryId: "mem-2" }, { ...CORRECT, sourceMessageId: "msg-other" }, { ...CORRECT, version: "2026-09-02T10:00:00.000Z" }]) {
      expect((await correct.execute(tampered, ctx({ approvalId: approval.id }))).success).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("an approval is used once: a second run with it changes nothing", async () => {
    const { correct, calls, approvals } = setup();
    const approval = approve(approvals, CORRECT);
    expect((await correct.execute(CORRECT, ctx({ approvalId: approval.id }))).success).toBe(true);
    expect((await correct.execute(CORRECT, ctx({ approvalId: approval.id }))).success).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["NOT_FOUND", /no longer exists/],
    ["STALE", /changed after you chose it/],
    ["NOT_LEARNABLE", /can't be saved as a memory/],
    ["BLOCKED", /paused/],
    ["SOURCE_NOT_FOUND", /couldn't find the message/],
    ["ALREADY_APPLIED", /already applied/],
    ["FAILED", /could not be changed/],
  ] as Array<[MemoryCorrectionStatus, RegExp]>)("a %s outcome fails the run and says nothing was changed", async (status, message) => {
    const { correct, approvals, journal } = setup({ correct: async () => ({ status }) });
    const approval = approve(approvals, CORRECT);

    const result = await correct.execute(CORRECT, ctx({ approvalId: approval.id }));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(message);
    expect((await journal.listByUserTool("user-1", "memory.correct")).map((r) => r.status)).toEqual(["FAILED"]);
  });

  it("a writer that throws fails closed", async () => {
    const { correct, approvals } = setup({
      correct: async () => {
        throw new Error("the new value: I prefer light mode");
      },
    });
    const approval = approve(approvals, CORRECT);
    const result = await correct.execute(CORRECT, ctx({ approvalId: approval.id }));
    expect(result.success).toBe(false);
    // The error's own message — which could carry the user's words — is not passed on.
    expect(result.error).not.toContain("light mode");
  });

  it("without a correction port, it is unavailable and consumes nothing", async () => {
    const { correct, approvals } = setup({ correct: undefined });
    const approval = approve(approvals, CORRECT);
    const result = await correct.execute(CORRECT, ctx({ approvalId: approval.id }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not available/);
    expect(approvals.get(approval.id)!.status).toBe("approved");
  });

  it("no parameter can name another user: the user is the execution context's", async () => {
    const { correct, calls, approvals } = setup();
    const approval = approve(approvals, CORRECT, { userId: "user-7" });
    await correct.execute(CORRECT, ctx({ userId: "user-7", approvalId: approval.id }));
    expect(calls[0]![1]).toBe("user-7");
  });
});

describe("Phase 14 — memory.purge_expired", () => {
  it("purges for the calling user and reports how many", async () => {
    const { purge, calls } = setup();
    expect(await purge.execute({}, ctx({ userId: "user-3" }))).toMatchObject({ success: true, data: { purged: 4 } });
    expect(calls).toEqual([["purgeExpired", "user-3", null]]);
  });

  it.each([
    ["a user id", { userId: "user-2" }],
    ["memory ids", { memoryIds: ["mem-1"] }],
    ["a cutoff", { before: "2030-01-01T00:00:00.000Z" }],
    ["a scope", { scope: "ALL" }],
    ["a limit", { limit: 100000 }],
  ])("accepts no parameters at all — not even %s", (_name, params) => {
    const { purge } = setup();
    expect(purge.validate(params)).toBe(false);
    expect(purge.validate({})).toBe(true);
  });

  it("a failing purge fails closed, without the error's own message", async () => {
    const { purge } = setup({
      purgeExpired: async () => {
        throw new Error("connection string postgresql://user:secret@host");
      },
    });
    const result = await purge.execute({}, ctx());
    expect(result.success).toBe(false);
    expect(result.error).not.toContain("secret");
  });

  it("without a retention port it is unavailable", async () => {
    const { purge } = setup({ purgeExpired: undefined });
    expect((await purge.execute({}, ctx())).success).toBe(false);
  });
});

describe("Phase 14 — memory.list is scoped by the conversation it is called in", () => {
  it("passes the execution context's conversation to the port — never a parameter", async () => {
    const { list, calls } = setup();
    await list.execute({ limit: 5 }, ctx({ conversationId: "conv-1" }));
    expect(calls).toEqual([["list", "user-1", { limit: 5, includeExpired: false, conversationId: "conv-1" }]]);
  });

  it("no parameter can choose a project or a conversation", () => {
    const { list } = setup();
    expect(list.validate({ projectId: "proj-1" })).toBe(false);
    expect(list.validate({ conversationId: "conv-2" })).toBe(false);
    expect(list.validate({ scope: "ALL" })).toBe(false);
  });

  it("with no conversation in the context, none is passed", async () => {
    const { list, calls } = setup();
    await list.execute({}, ctx());
    expect(calls).toEqual([["list", "user-1", { includeExpired: false }]]);
  });
});

describe("Phase 14 — the tool ids are the contract's", () => {
  it("come from core, so no other spelling can be registered", () => {
    expect(MEMORY_CORRECT_TOOL_ID).toBe("memory.correct");
    expect(MEMORY_PURGE_TOOL_ID).toBe("memory.purge_expired");
  });
});
