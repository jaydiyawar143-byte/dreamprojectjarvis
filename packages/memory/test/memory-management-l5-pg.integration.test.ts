// S7.2 L5 — memory management against the REAL repositories and PostgreSQL +
// pgvector: hard deletion, user isolation, the empty-list trap, forget-all,
// stale targets, and the learning controls (veto, pause) as the extraction
// path actually persists them.
//
// SAFETY. DATABASE_URL is read BEFORE anything imports the Prisma client. The
// suite runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one.
import { describe, it, expect, afterAll } from "vitest";
import type { EmbeddingRequest, EmbeddingResponse, IAIProvider, IEmbeddingProvider } from "@jarvis/core";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);

type Db = typeof import("@jarvis/db");
type Memory = typeof import("../src/index.js");
let db: Db | null = null;
let mem: Memory | null = null;
let prisma: InstanceType<Db["PrismaClient"]> | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  db = await import("@jarvis/db");
  mem = await import("../src/index.js");
  prisma = new db.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const DIMS = 1536;
const STAMP = Date.now();
const userIds: string[] = [];
const conversationIds: string[] = [];
const basis = (i: number) => Array.from({ length: DIMS }, (_, k) => (k === i ? 1 : 0));
const VECTORS: Record<string, number[]> = {
  "User prefers short captions": basis(1),
  "User works late": basis(2),
  "User prefers dark mode": basis(3),
};

const embeddings: IEmbeddingProvider = {
  id: "l5-embeddings",
  name: "L5 embeddings",
  dimensions: DIMS,
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return { embeddings: inputs.map((t) => VECTORS[t] ?? basis(9)), model: "l5" };
  },
  async isAvailable() {
    return true;
  },
};

function model(claim: string, quote: string): IAIProvider {
  return {
    id: "l5-model",
    name: "L5 model",
    defaultModel: "l5",
    async complete() {
      const candidates = [{ type: "PREFERENCE", content: claim, importance: 0.8, confidence: 0.9, source: "M1", evidence: quote }];
      return { message: { role: "assistant", content: JSON.stringify({ candidates }) }, finishReason: "stop", model: "l5" };
    },
    async listModels() {
      return ["l5"];
    },
    async isAvailable() {
      return true;
    },
  };
}

async function newUser(tag: string): Promise<string> {
  const u = await prisma!.user.create({
    data: { email: `s7-l5-${tag}-${STAMP}-${userIds.length}@jarvis-test.local`, name: `L5 ${tag}`, password: "not-a-real-password-hash", role: "VIEWER" },
  });
  userIds.push(u.id);
  return u.id;
}

function management() {
  return new mem!.MemoryManagementService({
    store: new db!.PrismaMemoryRepository(prisma!),
    control: new db!.PrismaPreferenceRepository(prisma!, "prefs:memory"),
    audit: { log: async () => undefined },
  });
}

/** One chat turn saved as the chat route saves it, then extracted with the user's learning controls. */
async function say(userId: string, text: string, claim: string, quote: string) {
  const conversations = new db!.PrismaConversationRepository(prisma!);
  const conversation = await conversations.create({ userId });
  conversationIds.push(conversation.id);
  const saved = await conversations.addMessage({ conversationId: conversation.id, role: "user", content: text, metadata: { traceId: "00000000-0000-4000-8000-000000000005" } });
  const service = new mem!.MemoryExtractionService({
    aiProvider: model(claim, quote),
    store: new db!.PrismaMemoryRepository(prisma!),
    embeddingProvider: embeddings,
    maxRetries: 0,
    learningControl: { get: (u) => management().learningControl(u) },
  });
  await service.extract({
    userId,
    conversationId: conversation.id,
    messages: [{ role: "user", content: text, messageId: saved.id, traceId: "00000000-0000-4000-8000-000000000005" }, { role: "assistant", content: "Noted." }],
    expiryDays: 90,
  });
  return { messageId: saved.id };
}

type Row = { id: string; content: string; confidence: number; expiresAt: Date | null; updatedAt: Date; metadata: string; hasVector: boolean };

async function rows(userId: string): Promise<Row[]> {
  return prisma!.$queryRawUnsafe<Row[]>(
    `SELECT "id", "content", "confidence", "expiresAt", "updatedAt", "metadata"::text AS "metadata", ("embedding" IS NOT NULL) AS "hasVector"
       FROM "Memory" WHERE "userId" = $1 ORDER BY "createdAt", "content"`,
    userId
  );
}

async function anywhere(memoryId: string): Promise<number> {
  const [row] = await prisma!.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "Memory" WHERE "id" = $1`, memoryId);
  return Number(row!.n);
}

const SHORT = ["User prefers short captions", "I prefer short captions"] as const;
const LATE = ["User works late", "I work late"] as const;

afterAll(async () => {
  if (dbUp) {
    await prisma!.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await prisma!.conversation.deleteMany({ where: { id: { in: conversationIds } } });
    if (userIds.length > 0) {
      await prisma!.userSetting.deleteMany({ where: { userId: { in: userIds } } });
      await prisma!.user.deleteMany({ where: { id: { in: userIds } } });
    }
  }
  await prisma?.$disconnect();
});

describe.skipIf(!dbUp)("S7.2 L5 — memory management (PostgreSQL)", () => {
  it("forgetting is a hard delete: the row, its vector and its metadata are gone, and nothing is orphaned", async () => {
    const u = await newUser("hard");
    await say(u, "I prefer short captions.", ...SHORT);
    await say(u, "I work late.", ...LATE);
    const [short, late] = await rows(u);
    expect(short!.hasVector).toBe(true);

    const outcome = await management().forget(u, [{ id: short!.id, version: short!.updatedAt.toISOString() }]);

    expect(outcome).toEqual({ status: "FORGOTTEN", deleted: 1, notFound: 0 });
    expect(await anywhere(short!.id)).toBe(0);
    expect((await rows(u)).map((r) => r.id)).toEqual([late!.id]);
  });

  it("another user can neither see nor delete a memory: NOT_FOUND, and the row is untouched", async () => {
    const a = await newUser("iso-a");
    const b = await newUser("iso-b");
    await say(a, "I prefer short captions.", ...SHORT);
    const [row] = await rows(a);
    const before = await rows(a);

    expect(await management().views(b, [row!.id])).toEqual([]);
    expect(await management().forget(b, [{ id: row!.id, version: row!.updatedAt.toISOString() }])).toEqual({ status: "NOT_FOUND", deleted: 0 });
    expect(await rows(a)).toEqual(before);
  });

  it("the empty-list trap is closed in the database too: an empty id list deletes nothing", async () => {
    const u = await newUser("trap");
    await say(u, "I prefer short captions.", ...SHORT);
    await say(u, "I work late.", ...LATE);

    expect(await new db!.PrismaMemoryRepository(prisma!).delete({ userId: u, memoryIds: [] })).toBe(0);
    expect(await management().forget(u, [])).toEqual({ status: "NOTHING_TO_FORGET", deleted: 0 });
    expect(await rows(u)).toHaveLength(2);
  });

  it("a stale target deletes nothing: the memory changed after the user chose it", async () => {
    const u = await newUser("stale");
    await say(u, "I prefer short captions.", ...SHORT);
    const [row] = await rows(u);
    const shownAt = row!.updatedAt.toISOString();
    await prisma!.$executeRawUnsafe(`UPDATE "Memory" SET "updatedAt" = now() + interval '1 second' WHERE "id" = $1`, row!.id);

    expect(await management().forget(u, [{ id: row!.id, version: shownAt }])).toEqual({ status: "STALE", deleted: 0, stale: 1 });
    expect(await anywhere(row!.id)).toBe(1);
  });

  it("forget-all ALL removes every memory of the user — expired ones too — and no one else's", async () => {
    const u = await newUser("all");
    const other = await newUser("all-other");
    await say(u, "I prefer short captions.", ...SHORT);
    await say(u, "I work late.", ...LATE);
    await say(other, "I prefer short captions.", ...SHORT);
    await prisma!.$executeRawUnsafe(`UPDATE "Memory" SET "expiresAt" = now() - interval '1 day' WHERE "userId" = $1 AND "content" = 'User works late'`, u);

    expect(await management().count(u, "ALL")).toBe(2);
    expect(await management().forgetAll(u, "ALL")).toEqual({ status: "FORGOTTEN", deleted: 2 });
    expect(await rows(u)).toEqual([]);
    expect(await rows(other)).toHaveLength(1);
  });

  it("forget-all LEGACY removes only memories from before provenance and evidence", async () => {
    const u = await newUser("legacy");
    await say(u, "I prefer short captions.", ...SHORT);
    const legacy = await prisma!.memory.create({
      data: { userId: u, type: "GOAL", content: "User wants to launch a SaaS", importance: 0.5, confidence: 0.9, sourceType: "conversation", metadata: {} },
    });

    const views = (await management().list(u)).memories;
    expect(views.map((v) => [v.content, v.legacy])).toEqual(
      expect.arrayContaining([
        ["User prefers short captions", false],
        ["User wants to launch a SaaS", true],
      ])
    );
    expect(await management().forgetAll(u, "LEGACY")).toEqual({ status: "FORGOTTEN", deleted: 1 });
    expect(await anywhere(legacy.id)).toBe(0);
    expect((await rows(u)).map((r) => r.content)).toEqual(["User prefers short captions"]);
  });

  it("a vetoed message persists nothing — and never corroborates the memory it repeats: evidence, confidence and expiry unchanged", async () => {
    const u = await newUser("veto");
    await say(u, "I prefer short captions.", ...SHORT);
    const before = await rows(u);

    // The veto is recorded against the next message's id before it is extracted.
    const conversations = new db!.PrismaConversationRepository(prisma!);
    const conversation = await conversations.create({ userId: u });
    conversationIds.push(conversation.id);
    const saved = await conversations.addMessage({ conversationId: conversation.id, role: "user", content: "I prefer short captions.", metadata: {} });
    await management().vetoSource(u, saved.id);
    const extractor = new mem!.MemoryExtractionService({
      aiProvider: model(...SHORT),
      store: new db!.PrismaMemoryRepository(prisma!),
      embeddingProvider: embeddings,
      maxRetries: 0,
      learningControl: { get: (id) => management().learningControl(id) },
    });
    await extractor.extract({
      userId: u,
      conversationId: conversation.id,
      messages: [{ role: "user", content: "I prefer short captions.", messageId: saved.id }, { role: "assistant", content: "Noted." }],
      expiryDays: 90,
    });

    expect(await rows(u)).toEqual(before);
    const setting = await prisma!.userSetting.findUnique({ where: { userId_key: { userId: u, key: "prefs:memory" } } });
    expect(JSON.parse(setting!.value)).toEqual({ v: 1, learningPaused: false, vetoedSourceMessageIds: [saved.id] });
  });

  it("while learning is paused nothing new is persisted and nothing old is touched; resuming restores learning", async () => {
    const u = await newUser("pause");
    await say(u, "I prefer short captions.", ...SHORT);
    const before = await rows(u);

    await management().pauseLearning(u);
    await say(u, "I work late.", ...LATE);
    await say(u, "I prefer short captions.", ...SHORT);
    expect(await rows(u)).toEqual(before);

    await management().resumeLearning(u);
    await say(u, "I work late.", ...LATE);
    expect((await rows(u)).map((r) => r.content)).toEqual(["User prefers short captions", "User works late"]);
  });
});
