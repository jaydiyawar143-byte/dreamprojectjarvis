// Phase 14 — `PrismaMemoryRepository.list()` returns ONE coherent view.
//
// THE DEFECT. `list()` read the page and the total as two independent
// statements. Under PostgreSQL's default READ COMMITTED each statement takes
// its own snapshot, so a write that committed between them produced an answer
// that was never true at any instant: `total: 1` beside an empty page. The API
// memory end-to-end test waited for `total === 1` and then read `memories[0]`,
// which is how it failed twice in eight runs on a cold database (Phase 14
// pre-development audit) with "Cannot read properties of undefined".
//
// THE CONTRACT. For one call, the page and the total describe the same
// snapshot: with no offset and a limit at least as large as the total, the
// page holds exactly `total` rows.
//
// The first test forces the interleaving deterministically — the total is
// taken only after a concurrent write has committed. The second is the same
// race, unforced, against a writer running flat out.
//
// SAFETY. Runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one.
import { describe, it, expect, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaMemoryRepository } from "../src/repositories/memory-repository.js";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);

const prisma = SAFE_TARGET ? new PrismaClient() : null;
let dbUp = false;
if (prisma) {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const STAMP = Date.now();
const userIds: string[] = [];

async function newUser(tag: string): Promise<string> {
  const user = await prisma!.user.create({
    data: { email: `p14-list-${tag}-${STAMP}-${userIds.length}@jarvis-test.local`, name: `P14 ${tag}`, password: "not-a-real-password-hash", role: "VIEWER" },
  });
  userIds.push(user.id);
  return user.id;
}

const row = (userId: string, i: number) => ({ userId, type: "FACT" as const, content: `p14 coherence ${i}`, importance: 0.5, confidence: 0.7 });

afterAll(async () => {
  if (dbUp && userIds.length > 0) await prisma!.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma?.$disconnect();
});

describe.skipIf(!dbUp)("Phase 14 — list() is one coherent view (PostgreSQL)", () => {
  it("a write that commits between the page read and the total read is in both or in neither", async () => {
    const userId = await newUser("forced");
    // A second connection pool: the concurrent writer, as another request is.
    const writer = new PrismaClient();
    try {
      // The interleaving, forced: the instant the repository asks for the
      // total, another connection commits a new memory — and the total is only
      // taken after that commit. A page read before it and a total read after
      // it disagree unless both are answered from one snapshot.
      let injected = false;
      const racing = prisma!.$extends({
        query: {
          memory: {
            async count({ args, query }) {
              if (!injected) {
                injected = true;
                await writer.memory.create({ data: row(userId, 1) });
              }
              return query(args);
            },
          },
        },
      });

      const result = await new PrismaMemoryRepository(racing as unknown as PrismaClient).list({ userId, limit: 50 });

      expect(injected).toBe(true);
      expect(result.memories.length).toBe(result.total);
      expect(result.hasMore).toBe(false);
    } finally {
      await writer.$disconnect();
    }
  });

  it("stays coherent while another connection creates and deletes memories flat out", async () => {
    const userId = await newUser("hammer");
    const repo = new PrismaMemoryRepository(prisma!);
    const writer = new PrismaClient();
    let writing = true;
    const churn = (async () => {
      for (let i = 0; writing; i++) {
        const created = await writer.memory.create({ data: row(userId, i) });
        if (i % 3 === 0) await writer.memory.delete({ where: { id: created.id } });
        if (i % 40 === 39) await writer.memory.deleteMany({ where: { userId } });
      }
    })();

    const incoherent: Array<{ total: number; page: number }> = [];
    try {
      for (let i = 0; i < 400; i++) {
        const { memories, total, hasMore } = await repo.list({ userId, limit: 50 });
        // The writer never lets the user hold 50 memories, so the page is the
        // whole set: any difference is a page and a total from two snapshots.
        if (memories.length !== total || hasMore) incoherent.push({ total, page: memories.length });
      }
    } finally {
      writing = false;
      await churn;
      await writer.$disconnect();
    }

    expect(incoherent).toEqual([]);
  });

  it("many reads at once all succeed, each one coherent", async () => {
    const userId = await newUser("burst");
    await prisma!.memory.createMany({ data: Array.from({ length: 5 }, (_, i) => row(userId, i)) });
    const repo = new PrismaMemoryRepository(prisma!);

    const results = await Promise.allSettled(Array.from({ length: 300 }, () => repo.list({ userId, limit: 50 })));

    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected.map((r) => (r.reason as { code?: string }).code ?? String(r.reason).slice(0, 80)).slice(0, 3)).toEqual([]);
    expect(results.every((r) => r.status === "fulfilled" && r.value.total === 5 && r.value.memories.length === 5)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HOW the one snapshot is taken — no database needed to check it.
//
// The first fix used an INTERACTIVE transaction. It was coherent, and it had a
// failure of its own: an interactive transaction waits only two seconds for a
// connection and then throws P2028. Measured here on PostgreSQL, 4,000
// simultaneous list() calls began failing with P2028 after about 2.5 seconds —
// so a burst of reads, or one stalled moment on a busy machine, could make
// list() throw where the two plain statements it replaced never could. A BATCH
// transaction gives the same single snapshot in one round trip and waits for a
// connection like any other query.
//
// That is pinned by its shape, not by a stress test: a test that passes or
// fails by how fast the machine is would be the flakiness this file exists to
// remove.
// ---------------------------------------------------------------------------

describe("Phase 14 — list() takes its snapshot with a batch transaction", () => {
  it("one batch of two reads at REPEATABLE READ — never an interactive transaction", async () => {
    const calls: Array<{ work: unknown; options: unknown }> = [];
    const fake = {
      memory: { findMany: () => Promise.resolve([]), count: () => Promise.resolve(0) },
      async $transaction(work: unknown, options: unknown) {
        calls.push({ work, options });
        return Array.isArray(work) ? Promise.all(work) : (work as (tx: unknown) => unknown)(fake);
      },
    };

    const result = await new PrismaMemoryRepository(fake as never).list({ userId: "user-1", limit: 10 });

    expect(result).toEqual({ memories: [], total: 0, hasMore: false });
    expect(calls).toHaveLength(1);
    expect(Array.isArray(calls[0]!.work), "a batch, not a callback").toBe(true);
    expect(calls[0]!.work as unknown[]).toHaveLength(2);
    expect(calls[0]!.options).toEqual({ isolationLevel: "RepeatableRead" });
  });
});
