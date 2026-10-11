// ---------------------------------------------------------------------------
// Audit F2 (Phase 14) — a confirmation answers ONE action: the one it names.
//
// `POST /pending-actions/:id/confirm` (and `/reject`, `/modify`) used to ignore
// the `:id` and act on whatever action was waiting in the conversation at that
// moment. A screen still showing an older request — a second tab, a stale
// card — could therefore confirm a DIFFERENT action from the one it showed:
// "forget X" on screen, "correct Y" executed.
//
// THE CONTRACT. The id in the path must be the action that is waiting. Any
// other id — stale, superseded, already used, unknown — changes nothing: no
// approval moves, no tool runs, and the waiting action is left exactly as it
// was. The matching id goes through the same approval and the same
// ToolExecutor call as before, for memory actions and Meta writes alike.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Approval, IToolExecutor, ToolExecutionRequest, ToolExecutionResult } from "@jarvis/core";
import { MEMORY_CORRECT_TOOL_ID } from "@jarvis/core";
import { PendingActionService } from "@jarvis/agents";
import { createPendingActionsRouter } from "../src/routes/pending-actions.js";

function approvalRepo() {
  const rows = new Map<string, Approval>();
  let seq = 0;
  return {
    rows,
    async create(data: Omit<Approval, "id" | "status" | "createdAt">): Promise<Approval> {
      const approval = { ...data, id: `ap-${++seq}`, status: "pending", createdAt: new Date().toISOString() } as Approval;
      rows.set(approval.id, approval);
      return approval;
    },
    async findById(id: string) {
      return rows.get(id) ?? null;
    },
    async updateStatus(id: string, status: string) {
      const approval = rows.get(id);
      if (!approval || approval.status === "consumed") return null;
      approval.status = status as Approval["status"];
      return approval;
    },
    async findPendingByConversationId(conversationId: string, userId: string) {
      return [...rows.values()].reverse().find((a) => a.conversationId === conversationId && a.userId === userId && a.status === "pending") ?? null;
    },
    async updateParams() {
      return null;
    },
  };
}

const tokenService = {
  verifyAccessToken: (token: string) => (/^token-user-\d+$/.test(token) ? { userId: token.slice(6), role: "member", email: "u@test.local" } : null),
} as never;

const servers: Array<{ close(): void }> = [];
afterEach(() => {
  while (servers.length > 0) servers.pop()!.close();
});

interface Reply {
  status: number;
  body: { success: boolean; data?: Record<string, any>; error?: { code: string; message: string } };
}

function world() {
  const approvals = approvalRepo();
  const pending = new PendingActionService({ approvalRepo: approvals, toolRegistry: { get: () => undefined, getAll: () => [] } });
  const executed: ToolExecutionRequest[] = [];
  const executor: IToolExecutor = {
    async execute(request): Promise<ToolExecutionResult> {
      executed.push(request);
      return { executionId: `exec-${executed.length}`, toolId: request.toolId, status: "completed", result: { success: true }, startedAt: new Date() };
    },
  };

  const app = express();
  app.use(express.json());
  app.use(
    "/pending-actions",
    createPendingActionsRouter({ tokenService, pendingActionService: pending, executor, toolRegistry: { get: (id: string) => ({ id }) }, googleWrites: null } as never)
  );
  const server = app.listen(0);
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(path: string, body: unknown, user = "user-1"): Promise<Reply> {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { authorization: `Bearer token-${user}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Reply["body"] };
  }

  async function propose(toolId: string, params: Record<string, unknown>, conversationId = "conv-1", userId = "user-1") {
    const { pendingAction } = await pending.createPendingAction({ conversationId, userId, toolId, action: `Run ${toolId}`, params, riskLevel: "HIGH_IMPACT" });
    return pendingAction;
  }

  const statusOf = (id: string) => approvals.rows.get(id)?.status;
  return { call, propose, pending, approvals, executed, statusOf };
}

const FORGET = { memoryIds: ["m-1"], versions: ["2026-09-01T10:00:00.000Z"] };
const CORRECT = { memoryId: "m-2", version: "2026-09-01T10:00:00.000Z", sourceMessageId: "msg-9" };

describe("F2 — the id in the path is the action that is answered", () => {
  it("1. the matching id confirms the action the user was shown, and runs exactly that one through the executor", async () => {
    const env = world();
    const shown = await env.propose("memory.forget", FORGET);

    const reply = await env.call(`/pending-actions/${shown.id}/confirm`, { conversationId: "conv-1" });

    expect(reply.status).toBe(200);
    expect(reply.body.data?.executionResult?.status).toBe("completed");
    expect(env.executed).toHaveLength(1);
    expect(env.executed[0]).toMatchObject({ toolId: "memory.forget", params: FORGET, approvalId: shown.id, userId: "user-1" });
    expect(env.statusOf(shown.id)).toBe("approved");
  });

  it("2. the matching id cancels the action the user was shown, and runs nothing", async () => {
    const env = world();
    const shown = await env.propose("memory.forget", FORGET);

    const reply = await env.call(`/pending-actions/${shown.id}/reject`, { conversationId: "conv-1" });

    expect(reply.status).toBe(200);
    expect(env.statusOf(shown.id)).toBe("rejected");
    expect(env.executed).toEqual([]);
  });

  it("3. a stale id cannot confirm the different action now waiting — 409, nothing runs, the waiting one is untouched", async () => {
    const env = world();
    const stale = await env.propose("memory.forget", FORGET);
    // What a second request does: the first is cancelled, a new one waits.
    await env.pending.rejectPendingAction("conv-1", "user-1");
    const waiting = await env.propose(MEMORY_CORRECT_TOOL_ID, CORRECT);

    const reply = await env.call(`/pending-actions/${stale.id}/confirm`, { conversationId: "conv-1" });

    expect(reply.status).toBe(409);
    expect(reply.body.success).toBe(false);
    expect(reply.body.error?.code).toBe("PENDING_ACTION_MISMATCH");
    expect(env.executed).toEqual([]);
    expect(env.statusOf(waiting.id)).toBe("pending");
    expect(env.statusOf(stale.id)).toBe("rejected");
  });

  it("3b. the same when the older action was superseded without being cancelled first", async () => {
    const env = world();
    const older = await env.propose("memory.forget", FORGET);
    const newer = await env.propose(MEMORY_CORRECT_TOOL_ID, CORRECT);

    const reply = await env.call(`/pending-actions/${older.id}/confirm`, { conversationId: "conv-1" });

    expect(reply.status).toBe(409);
    expect(env.executed).toEqual([]);
    expect(env.statusOf(newer.id)).toBe("pending");
    expect(env.statusOf(older.id)).toBe("pending");
  });

  it("4. a stale id cannot cancel the different action now waiting — 409, and it stays waiting", async () => {
    const env = world();
    const stale = await env.propose("memory.forget", FORGET);
    await env.pending.rejectPendingAction("conv-1", "user-1");
    const waiting = await env.propose(MEMORY_CORRECT_TOOL_ID, CORRECT);

    const reply = await env.call(`/pending-actions/${stale.id}/reject`, { conversationId: "conv-1" });

    expect(reply.status).toBe(409);
    expect(reply.body.error?.code).toBe("PENDING_ACTION_MISMATCH");
    expect(env.statusOf(waiting.id)).toBe("pending");
    expect(env.executed).toEqual([]);
  });

  it("5. two requests in a row: the first screen's confirm cannot run the second request; the second's own confirm runs only it", async () => {
    const env = world();
    const first = await env.propose("memory.forget", FORGET);
    await env.pending.rejectPendingAction("conv-1", "user-1");
    const second = await env.propose(MEMORY_CORRECT_TOOL_ID, CORRECT);

    expect((await env.call(`/pending-actions/${first.id}/confirm`, { conversationId: "conv-1" })).status).toBe(409);
    expect(env.executed).toEqual([]);

    const own = await env.call(`/pending-actions/${second.id}/confirm`, { conversationId: "conv-1" });
    expect(own.status).toBe(200);
    expect(env.executed).toHaveLength(1);
    expect(env.executed[0]).toMatchObject({ toolId: MEMORY_CORRECT_TOOL_ID, params: CORRECT, approvalId: second.id });
  });

  it("6. an id that was already used, or never existed, changes nothing", async () => {
    const env = world();
    const used = await env.propose("memory.forget", FORGET);
    expect((await env.call(`/pending-actions/${used.id}/confirm`, { conversationId: "conv-1" })).status).toBe(200);
    env.approvals.rows.get(used.id)!.status = "consumed";

    // Nothing waiting at all: the old answer, 404.
    const nothing = await env.call(`/pending-actions/${used.id}/confirm`, { conversationId: "conv-1" });
    expect(nothing.status).toBe(404);
    expect(nothing.body.error?.code).toBe("PENDING_ACTION_NOT_FOUND");

    // Something else waiting: a used or unknown id never reaches it.
    const waiting = await env.propose(MEMORY_CORRECT_TOOL_ID, CORRECT);
    for (const id of [used.id, "ap-999"]) {
      for (const verb of ["confirm", "reject"]) {
        const reply = await env.call(`/pending-actions/${id}/${verb}`, { conversationId: "conv-1" });
        expect(reply.status, `${verb} ${id}`).toBe(409);
      }
    }
    expect(env.statusOf(waiting.id)).toBe("pending");
    expect(env.executed).toHaveLength(1);
  });

  it("another user's action is never reached, even by its own id", async () => {
    const env = world();
    const theirs = await env.propose("memory.forget", FORGET, "conv-2", "user-2");

    const reply = await env.call(`/pending-actions/${theirs.id}/confirm`, { conversationId: "conv-2" }, "user-1");

    expect(reply.status).toBe(404);
    expect(env.statusOf(theirs.id)).toBe("pending");
    expect(env.executed).toEqual([]);
  });
});

describe("F2 — Meta writes and modification keep working, bound the same way", () => {
  const PAUSE = { campaignId: "c-1" };

  it("7. a Meta write confirmed by its own id runs exactly as before, with its own parameters", async () => {
    const env = world();
    const shown = await env.propose("meta.campaign.pause", PAUSE);

    const reply = await env.call(`/pending-actions/${shown.id}/confirm`, { conversationId: "conv-1" });

    expect(reply.status).toBe(200);
    expect(env.executed).toEqual([expect.objectContaining({ toolId: "meta.campaign.pause", params: PAUSE, approvalId: shown.id, role: "member" })]);
  });

  it("7b. a stale Meta card cannot confirm the Meta write that replaced it", async () => {
    const env = world();
    const stale = await env.propose("meta.campaign.pause", PAUSE);
    const waiting = await env.propose("meta.campaign.budget.update", { campaignId: "c-1", dailyBudget: 5000 });

    expect((await env.call(`/pending-actions/${stale.id}/confirm`, { conversationId: "conv-1" })).status).toBe(409);
    expect(env.executed).toEqual([]);
    expect(env.statusOf(waiting.id)).toBe("pending");
  });

  it("modify by the matching id still works for a write that may be modified", async () => {
    const env = world();
    const shown = await env.propose("meta.campaign.budget.update", { campaignId: "c-1", dailyBudget: 5000 });

    const reply = await env.call(`/pending-actions/${shown.id}/modify`, { conversationId: "conv-1", params: { dailyBudget: 3000 } });

    expect(reply.status).toBe(200);
    expect(reply.body.data?.pendingAction?.params).toEqual({ campaignId: "c-1", dailyBudget: 3000 });
    expect(env.statusOf(shown.id)).toBe("rejected");
  });

  it("modify by a stale id changes nothing — 409", async () => {
    const env = world();
    const stale = await env.propose("meta.campaign.pause", PAUSE);
    const waiting = await env.propose("meta.campaign.budget.update", { campaignId: "c-1", dailyBudget: 5000 });

    const reply = await env.call(`/pending-actions/${stale.id}/modify`, { conversationId: "conv-1", params: { dailyBudget: 1 } });

    expect(reply.status).toBe(409);
    expect(reply.body.error?.code).toBe("PENDING_ACTION_MISMATCH");
    expect(env.statusOf(waiting.id)).toBe("pending");
    expect(env.approvals.rows.get(waiting.id)!.params).toEqual({ campaignId: "c-1", dailyBudget: 5000 });
    expect(env.approvals.rows.size).toBe(2);
  });

  it("a memory correction can never be re-targeted through modify, by any id", async () => {
    const env = world();
    const correction = await env.propose(MEMORY_CORRECT_TOOL_ID, CORRECT);

    const reply = await env.call(`/pending-actions/${correction.id}/modify`, { conversationId: "conv-1", params: { memoryId: "m-other" } });

    expect(reply.status).toBe(409);
    expect(reply.body.error?.code).toBe("PENDING_ACTION_NOT_MODIFIABLE");
    expect(env.statusOf(correction.id)).toBe("pending");
    expect(env.approvals.rows.get(correction.id)!.params).toEqual(CORRECT);
    expect(env.approvals.rows.size).toBe(1);
  });
});
