// ---------------------------------------------------------------------------
// VO-2.1 (M2) — `PrismaTaskRepository.countByStatus` against REAL PostgreSQL.
//
// The Virtual Office said "N running" by counting the rows of a capped list.
// Past the cap the number stopped growing, so it undercounted or said
// "No work queued" while work was queued. The count is now ONE `GROUP BY
// status` in the database. These tests pin what that query must answer:
//
//   - every row the user owns, including rows past the list's cap;
//   - only the user's rows — the userId filter is unconditional;
//   - `createdBy` narrows (JARVIS work), and a NULL creator is not "jarvis";
//   - every lifecycle state present, at zero when none;
//   - a stored status outside the lifecycle is counted under no state.
//
// SAFETY. Runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one. With
// JARVIS_REQUIRE_POSTGRES=1 (CI) an unreachable database fails the suite
// rather than skipping it.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";

/** A URL that names a port, and not development's or deployment's. No port at all means 5432. */
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
/** Past `listByStatus`'s hard cap of 200, so a list-based count cannot reach it. */
const RUNNING_WORK = 230;

const ids = { alice: "", bob: "", empty: "" };
const userIds: string[] = [];

const repo = () => new mod!.PrismaTaskRepository(prisma!);

async function seed(
  userId: string,
  status: string,
  howMany: number,
  createdBy: string | null
): Promise<void> {
  await prisma!.task.createMany({
    data: Array.from({ length: howMany }, (_, index) => ({
      userId,
      title: `vo21 ${status} ${index}`,
      status,
      createdBy,
    })),
  });
}

beforeAll(async () => {
  if (!SAFE_TARGET && !REQUIRED) return;
  if (!dbUp) throw new Error("These tests need a separate PostgreSQL test database, and none could be reached.");

  for (const name of Object.keys(ids) as Array<keyof typeof ids>) {
    const user = await prisma!.user.create({
      data: {
        email: `vo21-${name}-${STAMP}@jarvis-test.local`,
        name: `VO-2.1 ${name}`,
        password: "not-a-real-password-hash",
        role: "VIEWER",
      },
    });
    ids[name] = user.id;
    userIds.push(user.id);
  }

  // Alice's JARVIS work, in every lifecycle state.
  await seed(ids.alice, "RUNNING", RUNNING_WORK, JARVIS);
  await seed(ids.alice, "PENDING", 4, JARVIS);
  await seed(ids.alice, "COMPLETED", 2, JARVIS);
  await seed(ids.alice, "FAILED", 1, JARVIS);
  await seed(ids.alice, "UNRESOLVED", 1, JARVIS);
  // Alice's rows that are NOT JARVIS work: dashboard todos (NULL creator)
  // and a row some other flow created.
  await seed(ids.alice, "PENDING", 3, null);
  await seed(ids.alice, "PENDING", 2, "some-other-flow");
  // A status no lifecycle state names. `status` is a string column.
  await seed(ids.alice, "ARCHIVED", 5, JARVIS);
  // Bob's work, which Alice's count must never include.
  await seed(ids.bob, "RUNNING", 7, JARVIS);
});

afterAll(async () => {
  if (dbUp && userIds.length > 0) {
    await prisma!.task.deleteMany({ where: { userId: { in: userIds } } });
    await prisma!.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma?.$disconnect();
});

describe.skipIf(!SAFE_TARGET && !REQUIRED)("VO-2.1 — countByStatus on PostgreSQL", () => {
  it("counts every row of the user's JARVIS work, past the list's cap", async () => {
    const counts = await repo().countByStatus(ids.alice, { createdBy: JARVIS });

    expect(counts).toEqual({
      PENDING: 4,
      RUNNING: RUNNING_WORK,
      COMPLETED: 2,
      FAILED: 1,
      UNRESOLVED: 1,
    });

    // The list the office used to count stops at its cap.
    const listed = await repo().listByStatus(ids.alice, "RUNNING", 1000, { createdBy: JARVIS });
    expect(listed).toHaveLength(200);
    expect(counts.RUNNING).toBeGreaterThan(listed.length);
  });

  it("without a creator filter counts all of the user's rows, todos included", async () => {
    const counts = await repo().countByStatus(ids.alice);

    // 4 JARVIS + 3 todos (NULL creator) + 2 from another flow.
    expect(counts.PENDING).toBe(9);
    expect(counts.RUNNING).toBe(RUNNING_WORK);
  });

  it("does not treat a NULL creator as JARVIS work", async () => {
    const work = await repo().countByStatus(ids.alice, { createdBy: JARVIS });
    const other = await repo().countByStatus(ids.alice, { createdBy: "some-other-flow" });

    expect(work.PENDING).toBe(4);
    expect(other).toEqual({ PENDING: 2, RUNNING: 0, COMPLETED: 0, FAILED: 0, UNRESOLVED: 0 });
  });

  it("never counts another user's rows", async () => {
    expect(await repo().countByStatus(ids.bob, { createdBy: JARVIS })).toEqual({
      PENDING: 0,
      RUNNING: 7,
      COMPLETED: 0,
      FAILED: 0,
      UNRESOLVED: 0,
    });
  });

  it("reports every state at zero for a user with no tasks", async () => {
    expect(await repo().countByStatus(ids.empty, { createdBy: JARVIS })).toEqual({
      PENDING: 0,
      RUNNING: 0,
      COMPLETED: 0,
      FAILED: 0,
      UNRESOLVED: 0,
    });
  });

  it("counts a status outside the lifecycle under no state", async () => {
    const counts = await repo().countByStatus(ids.alice, { createdBy: JARVIS });
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

    // 230 + 4 + 2 + 1 + 1 lifecycle rows; the 5 ARCHIVED rows are not in it.
    expect(total).toBe(RUNNING_WORK + 8);
    expect(Object.keys(counts).sort()).toEqual(
      ["COMPLETED", "FAILED", "PENDING", "RUNNING", "UNRESOLVED"]
    );
  });
});
