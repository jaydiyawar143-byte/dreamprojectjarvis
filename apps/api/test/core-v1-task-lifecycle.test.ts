// ---------------------------------------------------------------------------
// Core V1 — the task lifecycle, its tools, and self-knowledge.
//
// The store below is a FAITHFUL fake of PrismaTaskRepository, not a stub: it
// enforces the same two things the real one does — every read and write is
// filtered by userId, and `transitionOwned` is a compare-and-set on the
// current status. A fake that skipped either would let these tests pass while
// the property they exist to protect was broken.
//
// What is NOT covered here: the Postgres behaviour itself. These tests prove
// the rules; a database-backed suite would prove the row locks.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import {
  canTransitionTask,
  allowedTaskTransitions,
  type TaskStatus,
  type ToolContext,
} from "@jarvis/core";
import { createTaskTools, TASK_TOOL_IDS, type TaskPort, type TaskView } from "@jarvis/tools";
import { ToolRegistry } from "@jarvis/tools";
import { TaskService } from "../src/services/tasks/task-service.js";
import { SelfKnowledgeService } from "../src/services/self-knowledge/self-knowledge-service.js";
import { readBuildMetadata } from "../src/services/self-knowledge/build-metadata.js";
import type { TaskRecord } from "@jarvis/db";

// ---------------------------------------------------------------------------
// A task store that behaves like the real repository.
// ---------------------------------------------------------------------------

function makeStore() {
  const rows = new Map<string, TaskRecord>();
  let seq = 0;

  const store = {
    rows,
    async create(userId: string, input: { title: string; description?: string | null; createdBy?: string | null }) {
      const now = new Date();
      const row: TaskRecord = {
        id: `task-${++seq}`,
        userId,
        title: input.title,
        description: input.description ?? null,
        dueAt: null,
        priority: "NORMAL",
        status: "PENDING",
        startedAt: null,
        completedAt: null,
        error: null,
        remindedAt: null,
        createdBy: input.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return row;
    },
    async list(userId: string, options: { includeCompleted?: boolean; limit?: number } = {}) {
      return [...rows.values()]
        .filter((r) => r.userId === userId)
        .filter((r) => (options.includeCompleted ? true : r.completedAt === null))
        .slice(0, options.limit ?? 50);
    },
    async listByStatus(userId: string, status: TaskStatus, limit = 50) {
      return [...rows.values()]
        .filter((r) => r.userId === userId && r.status === status)
        .slice(0, limit);
    },
    async findOwned(userId: string, taskId: string) {
      const row = rows.get(taskId);
      // The ownership filter, exactly as the repository applies it: another
      // user's task is indistinguishable from one that does not exist.
      return row && row.userId === userId ? row : null;
    },
    async transitionOwned(
      userId: string,
      taskId: string,
      expectedFrom: TaskStatus,
      to: TaskStatus,
      options: { error?: string | null } = {}
    ) {
      const row = rows.get(taskId);
      if (!row || row.userId !== userId) {
        return { ok: false as const, reason: "not_found" as const, current: null };
      }
      // Compare-and-set. The loser of a race matches nothing and is refused.
      if (row.status !== expectedFrom) {
        return { ok: false as const, reason: "state_changed" as const, current: row.status };
      }
      row.status = to;
      if (to === "RUNNING") row.startedAt = new Date();
      if (to === "COMPLETED") {
        row.completedAt = new Date();
        row.error = null;
      }
      if (to === "FAILED") row.error = options.error ?? null;
      row.updatedAt = new Date();
      return { ok: true as const, task: row };
    },
  };

  return store;
}

function makeService() {
  const store = makeStore();
  return { store, service: new TaskService({ tasks: store }) };
}

const ALICE = "user-alice";
const BOB = "user-bob";

// ---------------------------------------------------------------------------
// 1-4. Creation, retrieval, isolation, listing
// ---------------------------------------------------------------------------

describe("Core V1 — a task is recorded, not run", () => {
  it("1. creates a task in PENDING with no start or completion time", async () => {
    const { service } = makeService();
    const created = await service.createTask(ALICE, { title: "Prepare the Sputnikverse proposal" });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.task.status).toBe("PENDING");
    // The whole point of Core V1: creating work does not begin it.
    expect(created.task.startedAt).toBeNull();
    expect(created.task.completedAt).toBeNull();
    expect(created.task.error).toBeNull();
  });

  it("refuses a blank title rather than storing an unnamed task", async () => {
    const { service } = makeService();
    const created = await service.createTask(ALICE, { title: "   " });
    expect(created.ok).toBe(false);
  });

  it("2. retrieves a task by id", async () => {
    const { service } = makeService();
    const created = await service.createTask(ALICE, { title: "Analyze the Meta campaign" });
    if (!created.ok) throw new Error("setup failed");

    const found = await service.getTask(ALICE, created.task.id);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.task.title).toBe("Analyze the Meta campaign");
  });

  it("3. never returns another user's task, and says only 'no such task'", async () => {
    const { service } = makeService();
    const created = await service.createTask(ALICE, { title: "Alice's private work" });
    if (!created.ok) throw new Error("setup failed");

    const asBob = await service.getTask(BOB, created.task.id);
    expect(asBob.ok).toBe(false);
    if (asBob.ok) return;
    expect(asBob.reason).toBe("NOT_FOUND");
    // A different message for "exists but not yours" would confirm it exists.
    expect(asBob.message).toBe("No such task.");
  });

  it("3b. refuses to move a task belonging to someone else", async () => {
    const { store, service } = makeService();
    const created = await service.createTask(ALICE, { title: "Alice's work" });
    if (!created.ok) throw new Error("setup failed");

    const stolen = await service.startTask(BOB, created.task.id);
    expect(stolen.ok).toBe(false);
    // And Alice's task is untouched.
    expect(store.rows.get(created.task.id)!.status).toBe("PENDING");
  });

  it("4. lists only the caller's tasks, and can filter by status", async () => {
    const { service } = makeService();
    await service.createTask(ALICE, { title: "A1" });
    const a2 = await service.createTask(ALICE, { title: "A2" });
    await service.createTask(BOB, { title: "B1" });
    if (!a2.ok) throw new Error("setup failed");
    await service.startTask(ALICE, a2.task.id);

    const all = await service.listTasks(ALICE);
    expect(all).toHaveLength(2);
    expect(all.every((t) => t.userId === ALICE)).toBe(true);

    const running = await service.listTasks(ALICE, { status: "RUNNING" });
    expect(running).toHaveLength(1);
    expect(running[0]!.title).toBe("A2");

    expect(await service.listTasks(BOB)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5-8. The lifecycle
// ---------------------------------------------------------------------------

describe("Core V1 — the lifecycle allows exactly the moves it documents", () => {
  let store: ReturnType<typeof makeStore>;
  let service: TaskService;
  let taskId: string;

  beforeEach(async () => {
    const made = makeService();
    store = made.store;
    service = made.service;
    const created = await service.createTask(ALICE, { title: "Work" });
    if (!created.ok) throw new Error("setup failed");
    taskId = created.task.id;
  });

  it("5. PENDING -> RUNNING stamps startedAt", async () => {
    const started = await service.startTask(ALICE, taskId);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.task.status).toBe("RUNNING");
    expect(started.task.startedAt).not.toBeNull();
    expect(started.task.completedAt).toBeNull();
  });

  it("6. RUNNING -> COMPLETED stamps completedAt and clears any error", async () => {
    await service.startTask(ALICE, taskId);
    const done = await service.completeTask(ALICE, taskId);

    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.task.status).toBe("COMPLETED");
    expect(done.task.completedAt).not.toBeNull();
    expect(done.task.error).toBeNull();
  });

  it("7. RUNNING -> FAILED records the reason and does NOT mark it done", async () => {
    await service.startTask(ALICE, taskId);
    const failed = await service.failTask(ALICE, taskId, "The provider refused the request.");

    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.task.status).toBe("FAILED");
    expect(failed.task.error).toBe("The provider refused the request.");
    // completedAt is what the existing Tasks widget reads as "done". A failed
    // task is finished but NOT done, so it stays visible as outstanding.
    expect(failed.task.completedAt).toBeNull();
  });

  it("8. refuses PENDING -> COMPLETED: work cannot finish without starting", async () => {
    const jumped = await service.completeTask(ALICE, taskId);
    expect(jumped.ok).toBe(false);
    if (jumped.ok) return;
    expect(jumped.reason).toBe("INVALID_TRANSITION");
    expect(store.rows.get(taskId)!.status).toBe("PENDING");
  });

  it("8b. refuses to move a task out of a terminal state", async () => {
    await service.startTask(ALICE, taskId);
    await service.completeTask(ALICE, taskId);

    const reopened = await service.startTask(ALICE, taskId);
    expect(reopened.ok).toBe(false);
    if (reopened.ok) return;
    expect(reopened.reason).toBe("INVALID_TRANSITION");
    expect(reopened.message).toMatch(/already completed/i);

    // And the same for FAILED, which is equally terminal in Core V1: there is
    // no retry model here to reuse, so re-running is a later decision.
    const other = makeService();
    const t = await other.service.createTask(ALICE, { title: "W" });
    if (!t.ok) throw new Error("setup failed");
    await other.service.startTask(ALICE, t.task.id);
    await other.service.failTask(ALICE, t.task.id, "nope");
    expect((await other.service.startTask(ALICE, t.task.id)).ok).toBe(false);
  });

  it("8c. the transition table itself is what the service enforces", () => {
    expect(canTransitionTask("PENDING", "RUNNING")).toBe(true);
    expect(canTransitionTask("RUNNING", "COMPLETED")).toBe(true);
    expect(canTransitionTask("RUNNING", "FAILED")).toBe(true);
    expect(canTransitionTask("COMPLETED", "RUNNING")).toBe(false);
    expect(canTransitionTask("FAILED", "RUNNING")).toBe(false);
    expect(canTransitionTask("PENDING", "COMPLETED")).toBe(false);
    expect(allowedTaskTransitions("COMPLETED")).toHaveLength(0);
    expect(allowedTaskTransitions("FAILED")).toHaveLength(0);
  });

  it("8d. a second concurrent start loses, rather than both succeeding", async () => {
    const [first, second] = await Promise.all([
      service.startTask(ALICE, taskId),
      service.startTask(ALICE, taskId),
    ]);
    const wins = [first, second].filter((r) => r.ok);
    expect(wins).toHaveLength(1);
    expect(store.rows.get(taskId)!.status).toBe("RUNNING");
  });
});

// ---------------------------------------------------------------------------
// 9-10. The tools
// ---------------------------------------------------------------------------

function makeTaskPort(service: TaskService): TaskPort {
  const view = (t: TaskRecord): TaskView => ({
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    createdAt: t.createdAt.toISOString(),
    startedAt: t.startedAt ? t.startedAt.toISOString() : null,
    completedAt: t.completedAt ? t.completedAt.toISOString() : null,
    error: t.error,
  });

  return {
    create: async (userId, input) => {
      const r = await service.createTask(userId, input);
      return r.ok ? { ok: true as const, task: view(r.task) } : { ok: false as const, message: r.message };
    },
    list: async (userId, options) => (await service.listTasks(userId, options)).map(view),
    get: async (userId, id) => {
      const r = await service.getTask(userId, id);
      return r.ok ? { ok: true as const, task: view(r.task) } : { ok: false as const, message: r.message };
    },
    updateStatus: async (userId, id, status, error) => {
      const r =
        status === "RUNNING"
          ? await service.startTask(userId, id)
          : status === "COMPLETED"
            ? await service.completeTask(userId, id)
            : await service.failTask(userId, id, error);
      return r.ok ? { ok: true as const, task: view(r.task) } : { ok: false as const, message: r.message };
    },
  };
}

/** A real ToolContext, not a cast: `userId` is what every tool scopes to. */
const CONTEXT: ToolContext = {
  userId: ALICE,
  traceId: "00000000-0000-0000-0000-000000000001",
};

describe("Core V1 — the task tools", () => {
  it("9. all four register, and every one is reachable through the registry", () => {
    const { service } = makeService();
    const registry = new ToolRegistry();
    for (const tool of createTaskTools(makeTaskPort(service))) registry.register(tool);

    for (const id of TASK_TOOL_IDS) {
      const tool = registry.get(id);
      expect(tool, id).toBeDefined();
    }
    expect(TASK_TOOL_IDS).toHaveLength(4);
  });

  it("9b. the writes are LOW_IMPACT and the reads are READ_ONLY — none approval-gated", () => {
    const { service } = makeService();
    const tools = createTaskTools(makeTaskPort(service));
    const byId = new Map(tools.map((t) => [t.id, t]));

    expect(byId.get("task.create")!.risk).toBe("LOW_IMPACT");
    expect(byId.get("task.updateStatus")!.risk).toBe("LOW_IMPACT");
    expect(byId.get("task.list")!.risk).toBe("READ_ONLY");
    expect(byId.get("task.get")!.risk).toBe("READ_ONLY");
    // These reach JARVIS's own store only — nothing leaves the process.
    expect(tools.every((t) => t.requiresApproval === false)).toBe(true);
  });

  it("9c. no tool takes a userId parameter, so no prompt can ask for another user's tasks", () => {
    const { service } = makeService();
    for (const tool of createTaskTools(makeTaskPort(service))) {
      expect(tool.parameters.map((p) => p.name), tool.id).not.toContain("userId");
    }
  });

  it("10. task.create persists, and says plainly that nothing runs it", async () => {
    const { store, service } = makeService();
    const tools = createTaskTools(makeTaskPort(service));
    const create = tools.find((t) => t.id === "task.create")!;

    const result = await create.execute(
      { title: "Prepare the Sputnikverse marketing proposal" },
      CONTEXT
    );

    expect(result.success).toBe(true);
    const data = result.data as { task: TaskView; note: string };
    expect(data.task.status).toBe("PENDING");
    expect(data.note).toMatch(/nothing runs it/i);

    // It is really in the store, owned by the caller, stamped as JARVIS's.
    const stored = store.rows.get(data.task.id)!;
    expect(stored.userId).toBe(ALICE);
    expect(stored.createdBy).toBe("jarvis");
  });

  it("10b. task.list and task.get read only the caller's tasks", async () => {
    const { service } = makeService();
    const tools = createTaskTools(makeTaskPort(service));
    const create = tools.find((t) => t.id === "task.create")!;
    const list = tools.find((t) => t.id === "task.list")!;
    const get = tools.find((t) => t.id === "task.get")!;

    await create.execute({ title: "Alice task" }, CONTEXT);
    const bobContext: ToolContext = { ...CONTEXT, userId: BOB };

    const bobList = await list.execute({}, bobContext);
    expect((bobList.data as { count: number }).count).toBe(0);

    const aliceList = await list.execute({}, CONTEXT);
    const aliceTasks = (aliceList.data as { tasks: TaskView[] }).tasks;
    expect(aliceTasks).toHaveLength(1);

    // Bob cannot fetch Alice's task even with its exact id.
    const stolen = await get.execute({ taskId: aliceTasks[0]!.id }, bobContext);
    expect(stolen.success).toBe(false);
  });

  it("10c. task.updateStatus walks the lifecycle and refuses an illegal move", async () => {
    const { service } = makeService();
    const tools = createTaskTools(makeTaskPort(service));
    const create = tools.find((t) => t.id === "task.create")!;
    const update = tools.find((t) => t.id === "task.updateStatus")!;

    const created = await create.execute({ title: "Work" }, CONTEXT);
    const id = (created.data as { task: TaskView }).task.id;

    const started = await update.execute({ taskId: id, status: "running" }, CONTEXT);
    expect(started.success).toBe(true);
    expect((started.data as { task: TaskView }).task.status).toBe("RUNNING");

    const done = await update.execute({ taskId: id, status: "COMPLETED" }, CONTEXT);
    expect(done.success).toBe(true);

    const again = await update.execute({ taskId: id, status: "RUNNING" }, CONTEXT);
    expect(again.success).toBe(false);
    expect(again.error).toMatch(/already completed/i);
  });

  it("10d. rejects a status the lifecycle does not have, instead of ignoring it", async () => {
    const { service } = makeService();
    const tools = createTaskTools(makeTaskPort(service));
    const list = tools.find((t) => t.id === "task.list")!;
    const update = tools.find((t) => t.id === "task.updateStatus")!;

    const listed = await list.execute({ status: "urgent" }, CONTEXT);
    expect(listed.success).toBe(false);

    const moved = await update.execute({ taskId: "x", status: "PENDING" }, CONTEXT);
    expect(moved.success).toBe(false);
    expect(moved.error).toMatch(/cannot be moved back to pending/i);
  });
});

// ---------------------------------------------------------------------------
// 12-13. Self-knowledge
// ---------------------------------------------------------------------------

describe("Core V1 — self-knowledge", () => {
  const build = {
    name: "JARVIS",
    version: "1.2.3",
    gitCommit: "abc1234",
    environment: "test",
  };

  function makeSelf(overrides: { capabilities?: unknown; available?: boolean } = {}) {
    return new SelfKnowledgeService({
      build,
      capabilities:
        overrides.capabilities === undefined
          ? {
              report: async () => ({
                summary: { total: 42, executable: 30, requiresConfirmation: 9, unavailable: 3, planned: 0 },
                capabilities: [],
                integrations: [],
                general: [],
              }),
              connectedIntegrations: async () => [
                {
                  integration: "google",
                  name: "Google",
                  account: "s•••@example.com",
                  health: "HEALTHY",
                } as never,
              ],
            }
          : (overrides.capabilities as never),
      model: {
        id: "openai",
        name: "OpenAI",
        defaultModel: "gpt-4o",
        isAvailable: async () => overrides.available ?? true,
      },
    });
  }

  it("12. reports build, environment, model and live capability counts", async () => {
    const self = await makeSelf().describe(ALICE);

    expect(self.identity).toEqual(build);
    expect(self.model).toEqual({
      provider: "openai",
      providerName: "OpenAI",
      model: "gpt-4o",
      available: true,
    });
    // Derived from CapabilityService, not written down here.
    expect(self.capabilities?.total).toBe(42);
    expect(self.connectedIntegrations).toEqual([
      { id: "google", name: "Google", account: "s•••@example.com", health: "HEALTHY" },
    ]);
  });

  it("12b. reports unknown, not zero, when capabilities cannot be read", async () => {
    const self = await makeSelf({ capabilities: null }).describe(ALICE);
    // "I cannot see my capabilities" and "I have none" are different answers.
    expect(self.capabilities).toBeNull();
    expect(self.connectedIntegrations).toBeNull();
    // The model is still knowable without integration state.
    expect(self.model.model).toBe("gpt-4o");
  });

  it("12c. an unusable provider is reported as unavailable, not hidden", async () => {
    const self = await makeSelf({ available: false }).describe(ALICE);
    expect(self.model.available).toBe(false);
  });

  it("12d. a provider whose probe throws does not fail the whole description", async () => {
    const self = new SelfKnowledgeService({
      build,
      capabilities: null,
      model: {
        id: "openai",
        name: "OpenAI",
        defaultModel: "gpt-4o",
        isAvailable: async () => {
          throw new Error("ECONNREFUSED 10.0.0.1:443");
        },
      },
    });

    const described = await self.describe(ALICE);
    expect(described.model.available).toBe(false);
    // The provider's error text is an internal detail and must not travel.
    expect(JSON.stringify(described)).not.toMatch(/ECONNREFUSED|10\.0\.0\.1/);
  });

  it("13. exposes no secret, and cannot: it never reads the environment", async () => {
    // Real-looking secrets in the environment the service composes over.
    process.env.OPENAI_API_KEY = "sk-test-SHOULD-NEVER-APPEAR";
    process.env.JARVIS_ENCRYPTION_KEY = "enc-SHOULD-NEVER-APPEAR";
    process.env.DATABASE_URL = "postgresql://user:p4ssw0rd@localhost:5432/db";

    try {
      const serialised = JSON.stringify(await makeSelf().describe(ALICE));

      for (const forbidden of [
        "sk-test-SHOULD-NEVER-APPEAR",
        "enc-SHOULD-NEVER-APPEAR",
        "p4ssw0rd",
        "postgresql://",
      ]) {
        expect(serialised, forbidden).not.toContain(forbidden);
      }

      // The structural guarantee behind that: the only keys in the payload are
      // the four declared ones. A future edit that widened this into an
      // environment dump would fail here, not in review.
      expect(Object.keys(JSON.parse(serialised)).sort()).toEqual([
        "capabilities",
        "connectedIntegrations",
        "identity",
        "model",
      ]);
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.JARVIS_ENCRYPTION_KEY;
      delete process.env.DATABASE_URL;
    }
  });

  it("13b. build metadata takes only named variables, and validates the commit", () => {
    const saved = { ...process.env };
    try {
      process.env.JARVIS_VERSION = "9.9.9";
      process.env.NODE_ENV = "test";
      // Not a sha: a deploy script that exported the wrong variable must not
      // be able to put arbitrary text into an answer shown to the user.
      process.env.JARVIS_GIT_COMMIT = "sk-live-not-a-commit";
      delete process.env.GITHUB_SHA;

      const meta = readBuildMetadata();
      expect(meta.version).toBe("9.9.9");
      expect(meta.environment).toBe("test");
      expect(meta.gitCommit).toBeNull();

      process.env.JARVIS_GIT_COMMIT = "A1B2C3D";
      expect(readBuildMetadata().gitCommit).toBe("a1b2c3d");

      delete process.env.JARVIS_GIT_COMMIT;
      delete process.env.JARVIS_VERSION;
      const bare = readBuildMetadata();
      // Unstamped is reported as unknown, never guessed.
      expect(bare.gitCommit).toBeNull();
      expect(bare.name).toBe("JARVIS");
    } finally {
      process.env = saved;
    }
  });
});
