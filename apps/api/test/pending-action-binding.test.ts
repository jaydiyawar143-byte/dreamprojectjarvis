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
    // The conditional write (PrismaApprovalRepository.decideApproval): only a
    // waiting approval changes; any other answer is told what happened instead.
    async decideApproval(id: string, userId: string, decision: "approve" | "reject") {
      const approval = rows.get(id);
      if (!approval || approval.userId !== userId) return { outcome: "not_found" };
      if (approval.status === "consumed") return { outcome: "already_consumed" };
      if (approval.status === "rejected") return { outcome: "already_rejected" };
      if (approval.status !== "pending") return { outcome: "conflict", currentState: approval.status.toUpperCase() };
      approval.status = decision === "approve" ? "approved" : "rejected";
      return { outcome: approval.status };
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

type Decision = "approve" | "reject";

/** Points a race needs to hold: after the waiting action is read, and around the write that resolves it. */
interface RaceHooks {
  afterRead?: () => Promise<void>;
  beforeWrite?: (decision: Decision) => Promise<void>;
  afterWrite?: (decision: Decision) => void;
}

/** Resolves for every party once `parties` of them have arrived. */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return () => {
    arrived++;
    if (arrived === parties) open();
    return opened;
  };
}

/** The `first` decision writes first; the other waits until it has finished. */
function writesFirst(first: Decision): RaceHooks {
  let done!: () => void;
  const firstDone = new Promise<void>((resolve) => (done = resolve));
  return {
    beforeWrite: async (decision) => {
      if (decision !== first) await firstDone;
    },
    afterWrite: (decision) => {
      if (decision === first) done();
    },
  };
}

function world(hooks: RaceHooks = {}) {
  const approvals = approvalRepo();
  const raced = {
    ...approvals,
    async findPendingByConversationId(conversationId: string, userId: string) {
      const found = await approvals.findPendingByConversationId(conversationId, userId);
      await hooks.afterRead?.();
      return found;
    },
    async decideApproval(id: string, userId: string, decision: Decision) {
      await hooks.beforeWrite?.(decision);
      try {
        return await approvals.decideApproval(id, userId, decision);
      } finally {
        hooks.afterWrite?.(decision);
      }
    },
  };
  const pending = new PendingActionService({ approvalRepo: raced, toolRegistry: { get: () => undefined, getAll: () => [] } });
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

  async function get(path: string, user = "user-1"): Promise<Reply> {
    const response = await fetch(base + path, {
      headers: { authorization: `Bearer token-${user}` },
    });
    return { status: response.status, body: (await response.json()) as Reply["body"] };
  }

  async function propose(toolId: string, params: Record<string, unknown>, conversationId = "conv-1", userId = "user-1") {
    const { pendingAction } = await pending.createPendingAction({ conversationId, userId, toolId, action: `Run ${toolId}`, params, riskLevel: "HIGH_IMPACT" });
    return pendingAction;
  }

  const statusOf = (id: string) => approvals.rows.get(id)?.status;
  return { call, get, propose, pending, approvals, executed, statusOf };
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

describe("Atomic resolution — answers that both read the action as waiting (in-process model of the conditional write)", () => {
  // The PostgreSQL version — two connection pools, the real repository, the
  // real executor and audit log — is pending-action-atomic-pg.integration.test.ts.
  const PAUSE = { campaignId: "c-1" };

  it.each(["approve", "reject"] as const)(
    "Confirm against Cancel (%s writes first): one 200, one 409 PENDING_ACTION_ALREADY_RESOLVED, and the executor runs only if Confirm won",
    async (first) => {
      const env = world({ afterRead: barrier(2), ...writesFirst(first) });
      const shown = await env.propose("meta.campaign.pause", PAUSE);

      const [confirm, cancel] = await Promise.all([
        env.call(`/pending-actions/${shown.id}/confirm`, { conversationId: "conv-1" }),
        env.call(`/pending-actions/${shown.id}/reject`, { conversationId: "conv-1" }),
      ]);

      const [winner, loser] = first === "approve" ? [confirm, cancel] : [cancel, confirm];
      expect(winner.status).toBe(200);
      expect(loser.status).toBe(409);
      expect(loser.body.success).toBe(false);
      expect(loser.body.error?.code).toBe("PENDING_ACTION_ALREADY_RESOLVED");
      expect(env.executed).toHaveLength(first === "approve" ? 1 : 0);
      expect(env.statusOf(shown.id)).toBe(first === "approve" ? "approved" : "rejected");
    }
  );

  it("two Confirms that both read the action as waiting: the executor runs once, and the other is told it was already confirmed", async () => {
    const env = world({ afterRead: barrier(2) });
    const shown = await env.propose("meta.campaign.pause", PAUSE);

    const replies = await Promise.all([
      env.call(`/pending-actions/${shown.id}/confirm`, { conversationId: "conv-1" }),
      env.call(`/pending-actions/${shown.id}/confirm`, { conversationId: "conv-1" }),
    ]);

    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(replies.find((r) => r.status === 409)!.body.error?.message).toMatch(/already confirmed/);
    expect(env.executed).toHaveLength(1);
  });

  it("Modify against Confirm, Confirm writing first: the Modify answers 409 and creates no replacement", async () => {
    const env = world({ afterRead: barrier(2), ...writesFirst("approve") });
    const shown = await env.propose("meta.campaign.budget.update", { campaignId: "c-1", dailyBudget: 5000 });

    const [confirm, modify] = await Promise.all([
      env.call(`/pending-actions/${shown.id}/confirm`, { conversationId: "conv-1" }),
      env.call(`/pending-actions/${shown.id}/modify`, { conversationId: "conv-1", params: { dailyBudget: 1 } }),
    ]);

    expect(confirm.status).toBe(200);
    expect(modify.status).toBe(409);
    expect(modify.body.error?.code).toBe("PENDING_ACTION_ALREADY_RESOLVED");
    expect(env.approvals.rows.size).toBe(1);
    expect(env.executed).toEqual([expect.objectContaining({ params: { campaignId: "c-1", dailyBudget: 5000 } })]);
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

// ---------------------------------------------------------------------------
// Phase 19.1 (audit C1) — a pending action is shown as a safe preview. A
// browser action's parameters ARE the sensitive payload: its typed text, its
// selected value, nested submitted values. The page still gets the id, the
// tool, the state and the approval id, so confirm/reject/modify keep working.
// ---------------------------------------------------------------------------
describe("Phase 19.1 — pending-action responses carry a safe preview only", () => {
  const secret = "hunter2-typed-into-a-page";

  it("GET returns no browser parameters and no typed value", async () => {
    const env = world();
    const shown = await env.propose("browser.type", {
      url: "https://example.com/login?token=abc",
      selector: 'input[name="password"]',
      text: secret,
    });

    const reply = await env.get("/pending-actions?conversationId=conv-1");

    expect(reply.status).toBe(200);
    expect(reply.body.data?.id).toBe(shown.id);
    expect(reply.body.data?.approvalId).toBe(shown.approvalId);
    expect(reply.body.data?.toolId).toBe("browser.type");
    expect(reply.body.data?.params).toEqual({});
    expect(JSON.stringify(reply.body)).not.toContain(secret);
    expect(JSON.stringify(reply.body)).not.toContain("example.com/login");
  });

  it("confirm returns no browser parameters and no typed value", async () => {
    const env = world();
    const shown = await env.propose("browser.submit", {
      url: "https://example.com/checkout",
      selector: "#pay",
      fields: { "#card": secret },
    });

    const reply = await env.call(`/pending-actions/${shown.id}/confirm`, { conversationId: "conv-1" });

    expect(reply.status).toBe(200);
    expect(reply.body.data?.pendingAction?.params).toEqual({});
    expect(JSON.stringify(reply.body)).not.toContain(secret);
    // The executor still received the real parameters server-side; only the
    // response is projected.
    expect(env.executed[0]).toMatchObject({ toolId: "browser.submit", params: { fields: { "#card": secret } } });
  });

  it("a Meta preview keeps the campaign facts the card renders", async () => {
    const env = world();
    await env.propose("meta.campaign.budget.update", {
      campaignId: "c-1",
      dailyBudget: 3000,
      status: "PAUSED",
      internalNote: secret,
    });

    const reply = await env.get("/pending-actions?conversationId=conv-1");

    expect(reply.status).toBe(200);
    expect(reply.body.data?.params).toEqual({ campaignId: "c-1", dailyBudget: 3000, status: "PAUSED" });
    expect(JSON.stringify(reply.body)).not.toContain(secret);
  });
});
