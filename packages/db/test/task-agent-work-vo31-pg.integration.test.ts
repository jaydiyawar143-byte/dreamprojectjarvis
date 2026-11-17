// ---------------------------------------------------------------------------
// VO-3.1 — the per-agent read and the assignment columns, on PostgreSQL.
//
// Pins, against a real database:
//
//   * `agentWork` returns only the user's own assigned work — another user's
//     task for the SAME agent never appears;
//   * `latest` is exact per (agent, terminal state), past any list cap;
//   * `transitionOwned` writes agent, tool and assignedAt with RUNNING;
//   * `setScheduleOwned` assigns with a schedule and clears both on cancel.
//
// Needs a SEPARATE test database (never development's 5432, never 5433); it is
// skipped otherwise, and CI's database steps run it with
// JARVIS_REQUIRE_POSTGRES=1. The same guard as the VO-2.1 counts test.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";

function isSeparateDatabase(url: string | undefined): boolean {
  try {
    const { port } = new URL(url ?? "");
    return port !== "" && port !== "5432" && port !== "5433";
  } catch {
    return false;
  }
}

const SAFE_TARGET = isSeparateDatabase(process.env.DATABASE_URL);
const REQUIRED = process.env.JARVIS_REQUIRE_POSTGRES === "1";

type Client = InstanceType<(typeof import("@prisma/client"))["PrismaClient"]>;
type RepoModule = typeof import("../src/repositories/task-repository.js");

let prisma: Client | null = null;
let mod: RepoModule | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  const Prisma = await import("@prisma/client");
  mod = await import("../src/repositories/task-repository.js");
  prisma = new Prisma.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const STAMP = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const JARVIS = "jarvis";
const ids = { alice: "", bob: "" };
const userIds: string[] = [];
const repo = () => new mod!.PrismaTaskRepository(prisma!);

/** Past the `active` bound and any page size: `latest` must still be exact. */
const OLD_COMPLETIONS = 260;

beforeAll(async () => {
  if (!SAFE_TARGET && !REQUIRED) return;
  if (!dbUp) throw new Error("These tests need a separate PostgreSQL test database, and none could be reached.");

  for (const name of Object.keys(ids) as Array<keyof typeof ids>) {
    const user = await prisma!.user.create({
      data: {
        email: `vo31-${name}-${STAMP}@jarvis-test.local`,
        name: `VO-3.1 ${name}`,
        password: "not-a-real-password-hash",
        role: "VIEWER",
      },
    });
    ids[name] = user.id;
    userIds.push(user.id);
  }

  const base = Date.UTC(2026, 10, 13, 8, 0, 0);
  await prisma!.task.createMany({
    data: Array.from({ length: OLD_COMPLETIONS }, (_, i) => ({
      userId: ids.alice,
      title: `old ${i}`,
      status: "COMPLETED",
      createdBy: JARVIS,
      agentId: "knowledge-agent",
      updatedAt: new Date(base + i * 1000),
    })),
  });
  await prisma!.task.create({
    data: {
      userId: ids.alice,
      title: "newest completion",
      status: "COMPLETED",
      createdBy: JARVIS,
      agentId: "knowledge-agent",
      updatedAt: new Date(base + 10_000_000),
    },
  });
  await prisma!.task.create({
    data: { userId: ids.alice, title: "alice failed", status: "FAILED", error: "refused", createdBy: JARVIS, agentId: "meta-ads-agent" },
  });
  await prisma!.task.create({
    data: { userId: ids.alice, title: "alice running", status: "RUNNING", createdBy: JARVIS, agentId: "knowledge-agent", toolId: "knowledge.search" },
  });
  // Not JARVIS work, and not assigned: neither belongs in the office's read.
  await prisma!.task.create({ data: { userId: ids.alice, title: "a todo", status: "PENDING", agentId: "knowledge-agent" } });
  await prisma!.task.create({ data: { userId: ids.alice, title: "unassigned", status: "PENDING", createdBy: JARVIS } });
  // Bob's work for the SAME agent.
  await prisma!.task.create({
    data: { userId: ids.bob, title: "bob running", status: "RUNNING", createdBy: JARVIS, agentId: "knowledge-agent" },
  });
  await prisma!.task.create({
    data: { userId: ids.bob, title: "bob done", status: "COMPLETED", createdBy: JARVIS, agentId: "knowledge-agent", updatedAt: new Date(base + 20_000_000) },
  });
});

afterAll(async () => {
  if (dbUp && userIds.length > 0) {
    await prisma!.task.deleteMany({ where: { userId: { in: userIds } } });
    await prisma!.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma?.$disconnect();
});

describe.skipIf(!SAFE_TARGET && !REQUIRED)("VO-3.1 — agentWork on PostgreSQL", () => {
  it("returns only the user's own assigned JARVIS work", async () => {
    const work = await repo().agentWork(ids.alice, { createdBy: JARVIS });
    const titles = [...work.active, ...work.latest].map((t) => t.title);
    expect(work.active.map((t) => t.title)).toEqual(["alice running"]);
    expect(titles).not.toContain("bob running");
    expect(titles).not.toContain("bob done");
    expect(titles).not.toContain("a todo");
    expect(titles).not.toContain("unassigned");
  });

  it("finds each agent's newest terminal task exactly, however many older ones there are", async () => {
    const work = await repo().agentWork(ids.alice, { createdBy: JARVIS });
    const latest = Object.fromEntries(work.latest.map((t) => [`${t.agentId}:${t.status}`, t.title]));
    expect(latest).toEqual({
      "knowledge-agent:COMPLETED": "newest completion",
      "meta-ads-agent:FAILED": "alice failed",
    });
  });

  it("writes agent, tool and assignedAt with PENDING -> RUNNING", async () => {
    const task = await prisma!.task.create({
      data: { userId: ids.alice, title: "to run", status: "PENDING", createdBy: JARVIS },
    });
    const moved = await repo().transitionOwned(ids.alice, task.id, "PENDING", "RUNNING", {
      executionId: "exec-vo31",
      agentId: "location-agent",
      toolId: "maps.route",
      assign: true,
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.task).toMatchObject({ status: "RUNNING", agentId: "location-agent", toolId: "maps.route", executionId: "exec-vo31" });
    expect(moved.task.assignedAt).toBeInstanceOf(Date);
    expect(moved.task.startedAt).toBeInstanceOf(Date);
  });

  it("assigns with a schedule and clears both on cancel", async () => {
    const task = await prisma!.task.create({
      data: { userId: ids.alice, title: "to schedule", status: "PENDING", createdBy: JARVIS },
    });
    const scheduled = await repo().setScheduleOwned(ids.alice, task.id, JARVIS, new Date(Date.now() + 3_600_000), {
      agentId: "knowledge-agent",
    });
    expect(scheduled).toMatchObject({ agentId: "knowledge-agent" });
    expect(scheduled!.assignedAt).toBeInstanceOf(Date);

    // Another user cannot assign or cancel it.
    expect(await repo().setScheduleOwned(ids.bob, task.id, JARVIS, null)).toBeNull();

    const cancelled = await repo().setScheduleOwned(ids.alice, task.id, JARVIS, null);
    expect(cancelled).toMatchObject({ scheduledAt: null, agentId: null, assignedAt: null });
  });
});
