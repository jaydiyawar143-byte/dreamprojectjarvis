// S7 Step 4 — memory retrieval repair contract, repository level, against REAL
// PostgreSQL + pgvector. TESTS FIRST: written before the repair and expected to
// FAIL against the current implementation (see S7 Step 1 and Step 3).
//
// What these pin (the approved Step 3 contract):
//   - recall() and findSimilar() return vector-backed rows WITHOUT selecting the
//     raw vector column (today `SELECT m.*` makes Prisma 5.22 throw
//     "Failed to deserialize column of type 'vector'");
//   - expired rows never come back;
//   - a minimum semantic similarity is applied;
//   - ties are broken deterministically by id;
//   - a failed vector write leaves no half-created row;
//   - one user's memories never reach another user.
//
// FIXTURES ARE DETERMINISTIC. Vectors are 1536-dimensional unit vectors built
// from basis directions, so every cosine similarity is known exactly. Rows are
// inserted with Prisma + one raw UPDATE for the vector, independent of the
// repository write path under repair. No network, no model, no sleeps.
//
// `minSimilarity` is the recall-request field the Step 3 contract adds (M2). It
// does not exist on MemoryRecallRequest yet, so it is passed through a
// deliberate cast; the tests fail at runtime, for the real reason, not at compile
// time.
//
// Uses dedicated users that are removed afterwards; Memory cascades from User.
// Skips automatically when the database is unreachable. Point DATABASE_URL at a
// separate test database, never the development one (AGENTS.md).
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });
import { describe, it, expect, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { MemoryRecallRequest } from "@jarvis/core";
import { PrismaMemoryRepository } from "../src/repositories/memory-repository.js";

const prisma = new PrismaClient();

// Connectivity probe at module evaluation: describe.skipIf() decides during
// collection, before any beforeAll hook.
let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}

const repo = new PrismaMemoryRepository(prisma);
const STAMP = Date.now();
const DIMS = 1536;
const userIds: string[] = [];

// ---------------------------------------------------------------------------
// Deterministic vectors
// ---------------------------------------------------------------------------

/** Unit vector with the given non-zero components, normalised. */
function unit(components: Record<number, number>): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const [i, x] of Object.entries(components)) v[Number(i)] = x;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

/** A unit vector whose cosine similarity to basis direction 0 is exactly `cos`. */
function atSimilarity(cos: number): number[] {
  return unit({ 0: cos, 1: Math.sqrt(1 - cos * cos) });
}

const QUERY = unit({ 0: 1 });
const RELEVANT = atSimilarity(0.9); // well above the 0.3 floor
const UNRELATED = atSimilarity(0.1); // below the 0.3 floor
const MIN_SIMILARITY = 0.3; // the orchestrator's default relevanceThreshold

const toSql = (v: number[]) => `[${v.join(",")}]`;
const inDays = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function newUser(tag: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `s7-${tag}-${STAMP}-${userIds.length}@jarvis-test.local`,
      name: `S7 ${tag}`,
      password: "not-a-real-password-hash",
      role: "VIEWER",
    },
  });
  userIds.push(user.id);
  return user.id;
}

async function insertMemory(opts: {
  userId: string;
  content: string;
  embedding: number[];
  expiresAt?: Date | null;
  importance?: number;
}): Promise<string> {
  const row = await prisma.memory.create({
    data: {
      userId: opts.userId,
      type: "PREFERENCE",
      content: opts.content,
      importance: opts.importance ?? 0.8,
      confidence: 1,
      sourceType: "s7-test",
      // The post-repair shape: the embedding kept in metadata AND in the vector.
      metadata: { embedding: opts.embedding },
      expiresAt: opts.expiresAt === undefined ? inDays(90) : opts.expiresAt,
    },
  });
  await prisma.$executeRawUnsafe(
    'UPDATE "Memory" SET "embedding" = $1::vector WHERE "id" = $2',
    toSql(opts.embedding),
    row.id
  );
  return row.id;
}

function recallRequest(userId: string, embedding: number[]): MemoryRecallRequest {
  return {
    userId,
    query: "s7 contract query",
    embedding,
    limit: 5,
    minSimilarity: MIN_SIMILARITY,
  } as MemoryRecallRequest; // `minSimilarity`: Step 3 contract field, not on the type yet.
}

afterAll(async () => {
  if (dbUp && userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Part 1 — recall
// ---------------------------------------------------------------------------

describe.skipIf(!dbUp)("S7 memory recall contract — PrismaMemoryRepository.recall (PostgreSQL)", () => {
  it("recall returns vector-backed memories without Prisma vector deserialization failure", async () => {
    const alice = await newUser("t1-alice");
    const bob = await newUser("t1-bob");
    const aliceMemory = await insertMemory({ userId: alice, content: "S7 T1 alice relevant", embedding: RELEVANT });
    await insertMemory({ userId: bob, content: "S7 T1 bob relevant", embedding: RELEVANT });

    const results = await repo.recall(recallRequest(alice, QUERY));

    const hit = results.find((r) => r.memory.id === aliceMemory);
    expect(hit, "the matching vector-backed memory is returned").toBeDefined();
    expect(typeof hit!.semanticScore).toBe("number");
    expect(hit!.semanticScore).toBeCloseTo(0.9, 3);
    // The application never needs the raw vector back.
    expect(Object.keys(hit!.memory)).not.toContain("embedding");
    // User isolation.
    expect(results.every((r) => r.memory.userId === alice)).toBe(true);
  });

  it("recall excludes expired vector memories", async () => {
    const user = await newUser("t2");
    const active = await insertMemory({ userId: user, content: "S7 T2 active", embedding: RELEVANT });
    // The expired row is the MORE similar one, so it would rank first if expiry
    // were not filtered.
    const expired = await insertMemory({ userId: user, content: "S7 T2 expired", embedding: QUERY, expiresAt: inDays(-1) });

    const ids = (await repo.recall(recallRequest(user, QUERY))).map((r) => r.memory.id);

    expect(ids).toContain(active);
    expect(ids).not.toContain(expired);
  });

  it("recall applies minimum semantic similarity", async () => {
    const user = await newUser("t3");
    const relevant = await insertMemory({ userId: user, content: "S7 T3 relevant", embedding: RELEVANT });
    const unrelated = await insertMemory({ userId: user, content: "S7 T3 unrelated", embedding: UNRELATED });

    const results = await repo.recall(recallRequest(user, QUERY));
    const ids = results.map((r) => r.memory.id);

    expect(ids).toContain(relevant);
    expect(ids).not.toContain(unrelated);
    expect(results.every((r) => r.semanticScore >= MIN_SIMILARITY)).toBe(true);
  });

  it("recall has deterministic ordering, ties broken by id", async () => {
    const user = await newUser("t4");
    const tied = [
      await insertMemory({ userId: user, content: "S7 T4 tie one", embedding: RELEVANT }),
      await insertMemory({ userId: user, content: "S7 T4 tie two", embedding: RELEVANT }),
      await insertMemory({ userId: user, content: "S7 T4 tie three", embedding: RELEVANT }),
    ];
    // Expected order uses the DATABASE's own id ordering (its collation), which is
    // what an `ORDER BY distance, m."id"` tie-breaker produces.
    const expected = (
      await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT "id" FROM "Memory" WHERE "id" = ANY($1::text[]) ORDER BY "id"',
        tied
      )
    ).map((r) => r.id);

    const first = (await repo.recall(recallRequest(user, QUERY))).map((r) => r.memory.id);
    const second = (await repo.recall(recallRequest(user, QUERY))).map((r) => r.memory.id);

    expect(first).toEqual(expected);
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// Part 5 — atomic vector write
// ---------------------------------------------------------------------------

describe.skipIf(!dbUp)("S7 memory write contract — atomic vector persistence (PostgreSQL)", () => {
  it("failed vector persistence does not leave a partially-created memory", async () => {
    const user = await newUser("t5");

    // Deterministic database failure: pgvector rejects a vector whose dimensions
    // do not match vector(1536) ("expected 1536 dimensions, not 3").
    await expect(
      repo.storeWithEmbedding(
        {
          userId: user,
          memories: [{ type: "FACT", content: "S7 T5 atomicity probe", importance: 0.5, confidence: 1 }],
        },
        [[0.1, 0.2, 0.3]]
      )
    ).rejects.toThrow();

    expect(await prisma.memory.count({ where: { userId: user } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Part 7 — findSimilar
// ---------------------------------------------------------------------------

describe.skipIf(!dbUp)("S7 memory findSimilar contract (PostgreSQL)", () => {
  it("findSimilar returns vector-backed memories using explicit columns", async () => {
    const user = await newUser("t6");
    const relevant = await insertMemory({ userId: user, content: "S7 T6 relevant", embedding: RELEVANT });

    const rows = await repo.findSimilar(user, QUERY, MIN_SIMILARITY, 10);

    const hit = rows.find((m) => m.id === relevant);
    expect(hit, "the matching vector-backed memory is returned").toBeDefined();
    expect(Object.keys(hit!)).not.toContain("embedding");
    expect(rows.every((m) => m.userId === user)).toBe(true);
  });

  it("findSimilar excludes expired memories", async () => {
    const user = await newUser("t7");
    const active = await insertMemory({ userId: user, content: "S7 T7 active", embedding: RELEVANT });
    const expired = await insertMemory({ userId: user, content: "S7 T7 expired", embedding: QUERY, expiresAt: inDays(-1) });

    const ids = (await repo.findSimilar(user, QUERY, MIN_SIMILARITY, 10)).map((m) => m.id);

    expect(ids).toContain(active);
    expect(ids).not.toContain(expired);
  });

  it("findSimilar respects the similarity threshold", async () => {
    const user = await newUser("t8");
    const relevant = await insertMemory({ userId: user, content: "S7 T8 relevant", embedding: RELEVANT });
    const unrelated = await insertMemory({ userId: user, content: "S7 T8 unrelated", embedding: UNRELATED });

    const ids = (await repo.findSimilar(user, QUERY, MIN_SIMILARITY, 10)).map((m) => m.id);

    expect(ids).toContain(relevant);
    expect(ids).not.toContain(unrelated);
  });
});

// ---------------------------------------------------------------------------
// Part 9 — user isolation
// ---------------------------------------------------------------------------

describe.skipIf(!dbUp)("S7 memory isolation contract (PostgreSQL)", () => {
  it("vector recall never returns another user's memory", async () => {
    const alice = await newUser("t9-alice");
    const bob = await newUser("t9-bob");
    // Same semantic content and the same vector for both users.
    const aliceMemory = await insertMemory({ userId: alice, content: "S7 T9 shared preference", embedding: RELEVANT });
    const bobMemory = await insertMemory({ userId: bob, content: "S7 T9 shared preference", embedding: RELEVANT });

    const forAlice = (await repo.recall(recallRequest(alice, QUERY))).map((r) => r.memory.id);
    const forBob = (await repo.recall(recallRequest(bob, QUERY))).map((r) => r.memory.id);

    expect(forAlice).toEqual([aliceMemory]);
    expect(forBob).toEqual([bobMemory]);
  });
});
