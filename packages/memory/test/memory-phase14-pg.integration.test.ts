// Phase 14 — duplicate detection, retention and the owner's view, on the REAL
// repositories and PostgreSQL + pgvector.
//
// DUPLICATES. Five outcomes, one of each, read back from the row:
//
//   exact duplicate       the same statement again        → corroborates
//   semantic duplicate    other words, the same vector    → corroborates
//   near duplicate        a refined wording (cosine 0.8)  → revises
//   contradiction         a statement and its negation    → revises, never corroborates
//   unrelated             nothing in common               → a second memory
//
// and the Phase 14 change: a memory OLDER than the newest 100 is still found,
// so restating it corroborates it instead of creating a second copy.
//
// RETENTION. Only a memory that expired more than the grace period ago is
// purged; the purge is bounded, scoped to one user, and audited by count.
//
// SAFETY. Runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one.
import { describe, it, expect, afterAll, vi } from "vitest";
import type { AuditEntry, EmbeddingRequest, EmbeddingResponse, IAIProvider, IEmbeddingProvider, IMemoryStore, MemoryListRequest } from "@jarvis/core";
import { MEMORY_RETENTION } from "@jarvis/core";
import { MemoryExtractionService } from "../src/memory-extraction-service.js";
import { MemoryManagementService } from "../src/memory-management-service.js";
import { MemoryRetentionSweep } from "../src/memory-retention-sweep.js";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);

type Db = typeof import("@jarvis/db");
let db: Db | null = null;
let prisma: InstanceType<Db["PrismaClient"]> | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  db = await import("@jarvis/db");
  prisma = new db.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const DIMS = 1536;
const DAY = 86_400_000;
const STAMP = Date.now();
const userIds: string[] = [];

const basis = (i: number) => Array.from({ length: DIMS }, (_, k) => (k === i ? 1 : 0));
/** cosine 0.8 with basis(i): inside the revise range, never a duplicate. */
const near = (i: number) => Array.from({ length: DIMS }, (_, k) => (k === i ? 0.8 : k === i + 1 ? 0.6 : 0));

const VECTORS: Record<string, number[]> = {
  "User prefers short captions": basis(1),
  // Other words, the same meaning — and, here, the same vector.
  "User likes short captions": basis(1),
  // A refinement of it.
  "User prefers short captions on Instagram": near(1),
  "User likes spicy food": basis(22),
  "User does not like spicy food": basis(22),
  "User works late": basis(6),
};

const embeddings: IEmbeddingProvider = {
  id: "p14-embeddings",
  name: "P14 embeddings",
  dimensions: DIMS,
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return { embeddings: inputs.map((t) => VECTORS[t] ?? basis(900)), model: "p14" };
  },
  async isAvailable() {
    return true;
  },
};

function model(claims: Array<[claim: string, quote: string]>): IAIProvider {
  return {
    id: "p14-model",
    name: "P14 model",
    defaultModel: "p14",
    async complete() {
      const candidates = claims.map(([content, evidence]) => ({ type: "PREFERENCE", content, importance: 0.8, confidence: 0.9, source: "M1", evidence }));
      return { message: { role: "assistant", content: JSON.stringify({ candidates }) }, finishReason: "stop", model: "p14" };
    },
    async listModels() {
      return ["p14"];
    },
    async isAvailable() {
      return true;
    },
  };
}

const repo = () => new db!.PrismaMemoryRepository(prisma!);

async function newUser(tag: string): Promise<string> {
  const u = await prisma!.user.create({
    data: { email: `p14-mem-${tag}-${STAMP}-${userIds.length}@jarvis-test.local`, name: `P14 ${tag}`, password: "not-a-real-password-hash", role: "VIEWER" },
  });
  userIds.push(u.id);
  return u.id;
}

/** One chat turn, saved as the chat route saves it, then extracted. */
async function say(userId: string, text: string, claims: Array<[string, string]>) {
  const conversations = new db!.PrismaConversationRepository(prisma!);
  const conversation = await conversations.create({ userId });
  const traceId = `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`;
  const message = await conversations.addMessage({ conversationId: conversation.id, role: "user", content: text, metadata: { traceId } });
  const quiet = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await new MemoryExtractionService({ aiProvider: model(claims), store: repo(), embeddingProvider: embeddings, maxRetries: 0 }).extract({
      userId,
      conversationId: conversation.id,
      messages: [{ role: "user", content: text, messageId: message.id, traceId }, { role: "assistant", content: "Noted." }],
      expiryDays: 90,
    });
  } finally {
    quiet.mockRestore();
  }
  return { messageId: message.id, conversationId: conversation.id };
}

interface Row {
  id: string;
  content: string;
  confidence: number;
  evidence: { count: number; conversations: number; revisions: number } | undefined;
}

async function rows(userId: string): Promise<Row[]> {
  const list = await prisma!.memory.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  return list.map((r) => ({ id: r.id, content: r.content, confidence: r.confidence, evidence: (r.metadata as { evidence?: Row["evidence"] } | null)?.evidence }));
}

const SHORT: Array<[string, string]> = [["User prefers short captions", "I prefer short captions"]];

/** A stored row with an expiry, written directly: retention is about rows, not how they were learned. */
async function stored(userId: string, content: string, expiresAt: Date | null): Promise<string> {
  const row = await prisma!.memory.create({ data: { userId, type: "FACT", content, importance: 0.5, confidence: 0.7, sourceType: "USER", expiresAt } });
  return row.id;
}

function management(now?: Date, store: IMemoryStore = repo()) {
  const audit: Array<Omit<AuditEntry, "id" | "timestamp">> = [];
  const service = new MemoryManagementService({
    store,
    control: new db!.PrismaPreferenceRepository(prisma!, "prefs:memory", "unreadable"),
    audit: { log: async (entry) => void audit.push(entry) },
    ...(now ? { now: () => now } : {}),
  });
  return { service, audit };
}

afterAll(async () => {
  if (dbUp && userIds.length > 0) {
    await prisma!.message.deleteMany({ where: { conversation: { userId: { in: userIds } } } });
    await prisma!.conversation.deleteMany({ where: { userId: { in: userIds } } });
    await prisma!.userSetting.deleteMany({ where: { userId: { in: userIds } } });
    await prisma!.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma?.$disconnect();
});

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

describe.skipIf(!dbUp)("Phase 14 — duplicate detection (PostgreSQL)", () => {
  it("exact duplicate: the same statement again corroborates — one memory, more evidence", async () => {
    const u = await newUser("dup-exact");
    await say(u, "I prefer short captions.", SHORT);
    await say(u, "I prefer short captions.", SHORT);

    const list = await rows(u);
    expect(list).toHaveLength(1);
    expect(list[0]!.evidence).toMatchObject({ count: 2, conversations: 2, revisions: 0 });
    expect(list[0]!.confidence).toBe(0.8);
  });

  it("semantic duplicate: other words with the same meaning corroborate — the stored wording stays", async () => {
    const u = await newUser("dup-semantic");
    await say(u, "I prefer short captions.", SHORT);
    await say(u, "I like short captions.", [["User likes short captions", "I like short captions"]]);

    const list = await rows(u);
    expect(list).toHaveLength(1);
    expect(list[0]!.content).toBe("User prefers short captions");
    expect(list[0]!.evidence).toMatchObject({ count: 2, conversations: 2, revisions: 0 });
  });

  it("near duplicate: a refined wording revises the memory — still one, with the new content", async () => {
    const u = await newUser("dup-near");
    await say(u, "I prefer short captions.", SHORT);
    await say(u, "I prefer short captions on Instagram.", [["User prefers short captions on Instagram", "I prefer short captions on Instagram"]]);

    const list = await rows(u);
    expect(list).toHaveLength(1);
    expect(list[0]!.content).toBe("User prefers short captions on Instagram");
    expect(list[0]!.evidence).toMatchObject({ count: 1, revisions: 1 });
    expect(list[0]!.confidence).toBe(0.7);
  });

  it("contradiction: a statement and its negation never corroborate — the newer one replaces the older", async () => {
    const u = await newUser("dup-contradiction");
    await say(u, "I like spicy food.", [["User likes spicy food", "I like spicy food"]]);
    await say(u, "I like spicy food.", [["User likes spicy food", "I like spicy food"]]);
    await say(u, "I do not like spicy food.", [["User does not like spicy food", "I do not like spicy food"]]);

    const list = await rows(u);
    expect(list).toHaveLength(1);
    expect(list[0]!.content).toBe("User does not like spicy food");
    // Derived from the new statement alone: the old 0.80 is not carried over.
    expect(list[0]!.evidence).toMatchObject({ count: 1, revisions: 1 });
    expect(list[0]!.confidence).toBe(0.7);
  });

  it("unrelated: a statement about something else is a second memory, and the first is untouched", async () => {
    const u = await newUser("dup-unrelated");
    await say(u, "I prefer short captions.", SHORT);
    await say(u, "I work late.", [["User works late", "I work late"]]);

    const list = await rows(u);
    expect(list.map((r) => r.content)).toEqual(["User prefers short captions", "User works late"]);
    expect(list.every((r) => r.evidence?.count === 1 && r.evidence.revisions === 0)).toBe(true);
  });

  it("a memory older than the newest 100 is still found: restating it corroborates, it is not stored twice", async () => {
    const u = await newUser("dup-window");
    await say(u, "I prefer short captions.", SHORT);
    const [original] = await rows(u);

    // 100 newer memories: the whole window dedup used to look at.
    await prisma!.memory.createMany({
      data: Array.from({ length: 100 }, (_, i) => ({ userId: u, type: "FACT" as const, content: `filler memory number ${i}`, importance: 0.3, confidence: 0.7, sourceType: "USER", createdAt: new Date(Date.now() + 1000 + i) })),
    });
    expect((await repo().list({ userId: u, limit: 100 })).memories.map((m) => m.id)).not.toContain(original!.id);

    await say(u, "I prefer short captions.", SHORT);

    const after = await rows(u);
    expect(after).toHaveLength(101);
    expect(after.filter((r) => r.content === "User prefers short captions")).toHaveLength(1);
    expect(after.find((r) => r.id === original!.id)!.evidence).toMatchObject({ count: 2, conversations: 2 });
  });
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

describe.skipIf(!dbUp)("Phase 14 — retention purge (PostgreSQL)", () => {
  const NOW = new Date();
  const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

  it("purges only what expired more than the grace period ago — for this user, and no one else", async () => {
    const u = await newUser("purge");
    const v = await newUser("purge-other");
    const longExpired = await stored(u, "expired 40 days ago", ago(40));
    const inGrace = await stored(u, "expired 5 days ago", ago(5));
    const current = await stored(u, "expires in 60 days", ago(-60));
    const never = await stored(u, "never expires", null);
    const others = await stored(v, "someone else's, expired 40 days ago", ago(40));

    const { service, audit } = management(NOW);
    expect(await service.purgeExpired(u)).toBe(1);

    const left = (await prisma!.memory.findMany({ where: { userId: { in: [u, v] } }, select: { id: true } })).map((r) => r.id);
    expect(left).not.toContain(longExpired);
    expect(left.sort()).toEqual([inGrace, current, never, others].sort());

    // Audited by count: no content, no ids of what was removed.
    expect(audit).toEqual([{ userId: u, action: "memory.retention_purge", result: "success", metadata: { deleted: 1 } }]);
    // Nothing left to purge: no deletion, no audit row.
    expect(await service.purgeExpired(u)).toBe(0);
    expect(audit).toHaveLength(1);
  });

  it("is bounded: one purge deletes at most the sweep batch, and the next takes the rest", async () => {
    const u = await newUser("purge-batch");
    const total = MEMORY_RETENTION.sweepBatch + 5;
    await prisma!.memory.createMany({
      data: Array.from({ length: total }, (_, i) => ({ userId: u, type: "FACT" as const, content: `long expired ${i}`, importance: 0.3, confidence: 0.7, expiresAt: ago(45) })),
    });

    const { service } = management(NOW);
    expect(await service.purgeExpired(u)).toBe(MEMORY_RETENTION.sweepBatch);
    expect(await prisma!.memory.count({ where: { userId: u } })).toBe(5);
    expect(await service.purgeExpired(u)).toBe(5);
    expect(await prisma!.memory.count({ where: { userId: u } })).toBe(0);
  });

  it("deletes nothing it should not even if the store ignores the expiry filter", async () => {
    const u = await newUser("purge-unfiltered");
    const longExpired = await stored(u, "expired 40 days ago", ago(40));
    const current = await stored(u, "current", ago(-30));
    const never = await stored(u, "never expires", null);

    // A store that returns EVERYTHING when asked only for expired rows.
    const real = repo();
    const careless = new Proxy(real, {
      get(target, property, receiver) {
        if (property !== "list") return Reflect.get(target, property, receiver);
        return (request: MemoryListRequest) => target.list({ userId: request.userId, includeExpired: true, limit: request.limit });
      },
    });

    expect(await management(NOW, careless).service.purgeExpired(u)).toBe(1);
    const left = (await prisma!.memory.findMany({ where: { userId: u }, select: { id: true } })).map((r) => r.id);
    expect(left).not.toContain(longExpired);
    expect(left.sort()).toEqual([current, never].sort());
  });

  it("the sweep visits the users who have something to purge, and one failure does not stop the rest", async () => {
    const a = await newUser("sweep-a");
    const b = await newUser("sweep-b");
    const c = await newUser("sweep-c");
    await stored(a, "a: long expired", ago(40));
    await stored(b, "b: long expired", ago(40));
    await stored(c, "c: only recently expired", ago(3));

    const { service } = management(NOW);
    const visited: string[] = [];
    const sweep = new MemoryRetentionSweep({
      // Narrowed to this test's users: the database is shared with other files.
      candidates: async (before, limit) => (await repo().usersWithExpiredMemories(before, 500)).filter((id) => [a, b, c].includes(id)).slice(0, limit),
      purge: async (userId) => {
        visited.push(userId);
        if (userId === a) throw new Error("this user's purge fails");
        return service.purgeExpired(userId);
      },
      now: () => NOW,
    });

    expect(await sweep.sweep()).toEqual({ users: 2, deleted: 1, failed: 1 });
    expect(visited.sort()).toEqual([a, b].sort());
    expect(await prisma!.memory.count({ where: { userId: a } })).toBe(1); // failed: left for the next sweep
    expect(await prisma!.memory.count({ where: { userId: b } })).toBe(0);
    expect(await prisma!.memory.count({ where: { userId: c } })).toBe(1); // still in its grace period
  });
});

describe("Phase 14 — the retention sweep is bounded", () => {
  it("visits at most the configured number of users in one pass, each once", async () => {
    const purge = vi.fn(async (_userId: string) => 1);
    const sweep = new MemoryRetentionSweep({
      candidates: async () => Array.from({ length: 80 }, (_, i) => `user-${i % 70}`),
      purge,
    });

    const result = await sweep.sweep();

    expect(result).toEqual({ users: MEMORY_RETENTION.sweepUsers, deleted: MEMORY_RETENTION.sweepUsers, failed: 0 });
    expect(purge).toHaveBeenCalledTimes(MEMORY_RETENTION.sweepUsers);
    expect(new Set(purge.mock.calls.map(([userId]) => userId)).size).toBe(MEMORY_RETENTION.sweepUsers);
  });

  it("asks for candidates that expired before the grace cutoff, and does nothing when there are none", async () => {
    const now = new Date("2026-10-08T00:00:00.000Z");
    const candidates = vi.fn(async () => [] as string[]);
    const purge = vi.fn(async () => 0);

    expect(await new MemoryRetentionSweep({ candidates, purge, now: () => now }).sweep()).toEqual({ users: 0, deleted: 0, failed: 0 });
    expect(candidates).toHaveBeenCalledWith(new Date(now.getTime() - MEMORY_RETENTION.purgeGraceDays * DAY), MEMORY_RETENTION.sweepUsers);
    expect(purge).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The owner's view
// ---------------------------------------------------------------------------

describe.skipIf(!dbUp)("Phase 14 — the owner's view of their memories (PostgreSQL)", () => {
  it("lists details with confidence, project and provenance — paged, searchable, scoped", async () => {
    const u = await newUser("details");
    const project = await new db!.PrismaProjectRepository(prisma!).create(u, { name: "Alpha" });
    const first = await say(u, "I prefer short captions.", SHORT);
    await say(u, "I prefer short captions.", SHORT);
    await repo().store({ userId: u, memories: [{ type: "PREFERENCE", content: "Project wording", importance: 0.5, confidence: 0.7, sourceType: "USER", projectId: project.id, embedding: basis(40) }] });

    const { service } = management();
    const names = new Map([[project.id, "Alpha"]]);

    const all = await service.details(u, {}, names);
    expect(all.total).toBe(2);
    const learned = all.memories.find((m) => m.content === "User prefers short captions")!;
    expect(learned).toMatchObject({ confidence: 0.8, confidenceLevel: "HIGH", projectId: null, expired: false, legacy: false, provenance: { source: "USER", statements: 2, conversations: 2, revisions: 0 } });
    expect(all.memories.find((m) => m.content === "Project wording")).toMatchObject({ projectId: project.id, projectName: "Alpha" });
    // Never the vector, the metadata or a source id.
    expect(JSON.stringify(all)).not.toMatch(/embedding|metadata|sourceMessageId|sourceConversationId/);
    expect(JSON.stringify(all)).not.toContain(first.messageId);

    expect((await service.details(u, { scope: { kind: "PERSONAL" } })).memories.map((m) => m.content)).toEqual(["User prefers short captions"]);
    expect((await service.details(u, { scope: { kind: "PROJECT", projectId: project.id } })).memories.map((m) => m.content)).toEqual(["Project wording"]);
    expect((await service.details(u, { search: "CAPTIONS" })).memories.map((m) => m.content)).toEqual(["User prefers short captions"]);
    expect(await service.details(u, { limit: 1, offset: 0 })).toMatchObject({ total: 2, hasMore: true });
    expect((await service.details(u, { limit: 1, offset: 1 })).hasMore).toBe(false);

    expect((await service.fromSourceMessage(u, first.messageId)).map((m) => m.content)).toEqual(["User prefers short captions"]);
    expect(await service.fromSourceMessage(u, "no-such-message")).toEqual([]);
  });

  it("one memory is found only by its owner", async () => {
    const owner = await newUser("detail-owner");
    const intruder = await newUser("detail-intruder");
    await say(owner, "I prefer short captions.", SHORT);
    const [row] = await rows(owner);

    const { service } = management();
    expect(await service.detail(owner, row!.id)).toMatchObject({ id: row!.id, content: "User prefers short captions", confidenceLevel: "MEDIUM" });
    expect(await service.detail(intruder, row!.id)).toBeNull();
    expect(await service.detail(owner, "no-such-memory")).toBeNull();
  });

  it("status reports the controls and how much is stored, without counting expired memories as active", async () => {
    const u = await newUser("status");
    await stored(u, "current", new Date(Date.now() + 30 * DAY));
    await stored(u, "never expires", null);
    await stored(u, "expired", new Date(Date.now() - DAY));

    const { service } = management();
    expect(await service.status(u)).toEqual({ learningPaused: false, vetoedSources: 0, active: 2, expired: 1, retention: { days: 90, purgeGraceDays: 30 } });

    await service.pauseLearning(u);
    await service.vetoSource(u, "msg-1");
    expect(await service.status(u)).toMatchObject({ learningPaused: true, vetoedSources: 1 });
  });
});
