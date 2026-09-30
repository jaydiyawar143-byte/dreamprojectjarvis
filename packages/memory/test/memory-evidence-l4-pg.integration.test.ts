// S7.2 L4 — evidence against the REAL repositories and PostgreSQL + pgvector.
//
// Every turn is saved as the chat route saves it (a Conversation, the user's
// Message with { traceId }), then extracted. Every assertion reads the row
// back: the evidence in metadata, the derived confidence, the expiry, and the
// vector still equal to metadata.embedding.
//
// SAFETY. DATABASE_URL is read BEFORE anything imports the Prisma client
// (which loads packages/db/.env on import). The suite runs only against an
// explicitly supplied, separate test database; otherwise it is skipped.
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import type { EmbeddingRequest, EmbeddingResponse, IAIProvider, IEmbeddingProvider, LearningEvidence } from "@jarvis/core";

vi.mock("@jarvis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jarvis/core")>();
  return { ...actual, resolveLearningEvidence: vi.fn(actual.resolveLearningEvidence) };
});

import { resolveLearningEvidence } from "@jarvis/core";
import { MemoryExtractionService } from "../src/memory-extraction-service.js";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;

type Db = typeof import("@jarvis/db");
let db: Db | null = null;
let prisma: InstanceType<Db["PrismaClient"]> | null = null;
let dbUp = false;
if (EXPLICIT_DATABASE_URL) {
  db = await import("@jarvis/db");
  prisma = new db.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const resolve = vi.mocked(resolveLearningEvidence);
const realResolve = (await vi.importActual<typeof import("@jarvis/core")>("@jarvis/core")).resolveLearningEvidence;

const DIMS = 1536;
const DAY = 86_400_000;
const STAMP = Date.now();
const userIds: string[] = [];
const conversationIds: string[] = [];
const basis = (i: number) => Array.from({ length: DIMS }, (_, k) => (k === i ? 1 : 0));
/** cosine 0.8 with basis(i): inside the merge range, never a duplicate. */
const near = (i: number) => Array.from({ length: DIMS }, (_, k) => (k === i ? 0.8 : k === i + 1 ? 0.6 : 0));

const VECTORS: Record<string, number[]> = {
  "User prefers short captions": basis(1),
  "User prefers long captions": near(1),
  "User prefers dark mode": basis(3),
  "User prefers dark mode everywhere": near(3),
  "User works late": basis(6),
  // L4.1 — orthogonal vectors: only the 0.92 word overlap could call these a duplicate.
  "User prefers to receive the weekly performance report every Monday morning": basis(20),
  "User prefers not to receive the weekly performance report every Monday morning": basis(21),
  // L4.1 — the same vector: a duplicate by cosine (1.0) before L4.1.
  "User likes spicy food": basis(22),
  "User does not like spicy food": basis(22),
};

const embeddings: IEmbeddingProvider = {
  id: "l4-embeddings",
  name: "L4 embeddings",
  dimensions: DIMS,
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return { embeddings: inputs.map((t) => VECTORS[t] ?? basis(9)), model: "l4" };
  },
  async isAvailable() {
    return true;
  },
};

/** A model that cites the user's message (M1) and quotes each claim's own words from it. */
function model(claims: Array<[claim: string, quote: string]>): IAIProvider {
  return {
    id: "l4-model",
    name: "L4 model",
    defaultModel: "l4",
    async complete() {
      const candidates = claims.map(([content, evidence]) => ({ type: "PREFERENCE", content, importance: 0.8, confidence: 0.9, source: "M1", evidence }));
      return { message: { role: "assistant", content: JSON.stringify({ candidates }) }, finishReason: "stop", model: "l4" };
    },
    async listModels() {
      return ["l4"];
    },
    async isAvailable() {
      return true;
    },
  };
}

async function newUser(tag: string): Promise<string> {
  const u = await prisma!.user.create({
    data: { email: `s7-l4-${tag}-${STAMP}-${userIds.length}@jarvis-test.local`, name: `L4 ${tag}`, password: "not-a-real-password-hash", role: "VIEWER" },
  });
  userIds.push(u.id);
  return u.id;
}

async function newConversation(userId: string): Promise<string> {
  const c = await new db!.PrismaConversationRepository(prisma!).create({ userId });
  conversationIds.push(c.id);
  return c.id;
}

/** One chat turn, saved as the chat route saves it; `replayOf` re-extracts an already saved message. */
async function say(
  userId: string,
  conversationId: string,
  text: string,
  claims: Array<[claim: string, quote: string]>,
  replayOf?: { messageId: string; traceId: string }
) {
  let saved = replayOf;
  if (!saved) {
    const traceId = `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`;
    const message = await new db!.PrismaConversationRepository(prisma!).addMessage({ conversationId, role: "user", content: text, metadata: { traceId } });
    saved = { messageId: message.id, traceId };
  }
  const service = new MemoryExtractionService({ aiProvider: model(claims), store: new db!.PrismaMemoryRepository(prisma!), embeddingProvider: embeddings, maxRetries: 0 });
  const logged: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  try {
    await service.extract({
      userId,
      conversationId,
      messages: [{ role: "user", content: text, messageId: saved.messageId, traceId: saved.traceId }, { role: "assistant", content: "Noted." }],
      expiryDays: 90,
    });
  } finally {
    spy.mockRestore();
  }
  return { ...saved, logged };
}

type Row = {
  id: string;
  content: string;
  confidence: number;
  expiresAt: Date | null;
  updatedAt: Date;
  metadata: string;
  vector: string;
  aligned: boolean;
};

async function rows(userId: string) {
  const list = await prisma!.$queryRawUnsafe<Row[]>(
    `SELECT "id", "content", "confidence", "expiresAt", "updatedAt", "metadata"::text AS "metadata", "embedding"::text AS "vector",
            ("embedding" = ("metadata"->'embedding')::text::vector) AS "aligned"
       FROM "Memory" WHERE "userId" = $1 ORDER BY "createdAt", "content"`,
    userId
  );
  return list.map((r) => ({ ...r, evidence: (JSON.parse(r.metadata) as { evidence?: LearningEvidence }).evidence, meta: JSON.parse(r.metadata) as Record<string, unknown> }));
}

const SHORT: Array<[string, string]> = [["User prefers short captions", "I prefer short captions"]];

afterEach(() => {
  resolve.mockReset();
  resolve.mockImplementation(realResolve);
});

afterAll(async () => {
  if (dbUp) {
    await prisma!.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await prisma!.conversation.deleteMany({ where: { id: { in: conversationIds } } });
    if (userIds.length > 0) await prisma!.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma?.$disconnect();
});

describe.skipIf(!dbUp)("S7.2 L4 — evidence (PostgreSQL)", () => {
  it("1. a new memory carries its evidence: one source, confidence 0.70, the model's number kept, vector aligned", async () => {
    const u = await newUser("new");
    const conv = await newConversation(u);
    const { messageId, traceId } = await say(u, conv, "I prefer short captions.", SHORT);

    const [row, ...rest] = await rows(u);
    expect(rest).toEqual([]);
    expect(row!.confidence).toBe(0.7);
    expect(row!.meta.modelConfidence).toBe(0.9);
    expect(row!.evidence).toMatchObject({ v: 1, count: 1, conversations: 1, revisions: 0, previousSourceMessageIds: [] });
    expect(row!.evidence!.sources).toEqual([{ messageId, conversationId: conv, traceId, kind: "DIRECT", at: row!.evidence!.firstSeenAt }]);
    expect(row!.aligned).toBe(true);
  });

  it("2–4. a duplicate from another conversation: still one row, evidence 2, confidence 0.80 — then 0.90 from a third", async () => {
    const u = await newUser("dup");
    await say(u, await newConversation(u), "I prefer short captions.", SHORT);
    await say(u, await newConversation(u), "I prefer short captions.", SHORT);

    let list = await rows(u);
    expect(list).toHaveLength(1);
    expect(list[0]!.evidence).toMatchObject({ count: 2, conversations: 2 });
    expect(list[0]!.confidence).toBe(0.8);

    await say(u, await newConversation(u), "I prefer short captions.", SHORT);
    list = await rows(u);
    expect(list).toHaveLength(1);
    expect(list[0]!.confidence).toBe(0.9);
    expect(list[0]!.aligned).toBe(true);
  });

  it("5. more from the same conversation: evidence grows, confidence does not", async () => {
    const u = await newUser("same");
    const conv = await newConversation(u);
    await say(u, conv, "I prefer short captions.", SHORT);
    await say(u, conv, "I prefer short captions.", SHORT);

    const [row] = await rows(u);
    expect(row!.evidence).toMatchObject({ count: 2, conversations: 1 });
    expect(row!.confidence).toBe(0.7);
  });

  it("6. replaying the same message changes nothing — not the evidence, not the row", async () => {
    const u = await newUser("replay");
    const conv = await newConversation(u);
    const first = await say(u, conv, "I prefer short captions.", SHORT);
    await say(u, await newConversation(u), "I prefer short captions.", SHORT);
    const before = await rows(u);

    await say(u, conv, "I prefer short captions.", SHORT, first);

    expect(await rows(u)).toEqual(before);
  });

  it("7. genuine corroboration refreshes the expiry to 90 days from now", async () => {
    const u = await newUser("expiry");
    await say(u, await newConversation(u), "I prefer short captions.", SHORT);
    await prisma!.$executeRawUnsafe(`UPDATE "Memory" SET "expiresAt" = now() + interval '1 day' WHERE "userId" = $1`, u);
    const t0 = Date.now();
    await say(u, await newConversation(u), "I prefer short captions.", SHORT);

    const [row] = await rows(u);
    expect(row!.expiresAt!.getTime()).toBeGreaterThanOrEqual(t0 + 90 * DAY - 60_000);
    expect(row!.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 90 * DAY + 60_000);
  });

  it("8–10. a revision resets the evidence, records the replaced statement's message, and keeps the vector aligned", async () => {
    const u = await newUser("revise");
    const first = await say(u, await newConversation(u), "I prefer short captions.", SHORT);
    await say(u, await newConversation(u), "I prefer short captions.", SHORT);
    expect((await rows(u))[0]!.confidence).toBe(0.8);

    const conv = await newConversation(u);
    const revision = await say(u, conv, "I prefer long captions now.", [["User prefers long captions", "I prefer long captions now"]]);

    const list = await rows(u);
    expect(list).toHaveLength(1);
    const row = list[0]!;
    expect(row.content).toBe("User prefers long captions");
    expect(row.confidence).toBe(0.7);
    expect(row.evidence).toMatchObject({ count: 1, conversations: 1, revisions: 1, previousSourceMessageIds: [first.messageId] });
    expect(row.evidence!.sources.map((s) => [s.messageId, s.conversationId])).toEqual([[revision.messageId, conv]]);
    expect(row.aligned).toBe(true);
    expect(row.meta.embedding).toEqual(near(1));
  });

  it("11. a mixed batch: one new, one corroborated, one revised — each written correctly, all aligned", async () => {
    const u = await newUser("mixed");
    await say(u, await newConversation(u), "I prefer short captions.", SHORT);
    await say(u, await newConversation(u), "I prefer dark mode.", [["User prefers dark mode", "I prefer dark mode"]]);

    await say(u, await newConversation(u), "I prefer short captions. I prefer dark mode everywhere. I work late.", [
      ["User prefers short captions", "I prefer short captions"],
      ["User prefers dark mode everywhere", "I prefer dark mode everywhere"],
      ["User works late", "I work late"],
    ]);

    const list = await rows(u);
    expect(list.map((r) => [r.content, r.evidence!.count, r.evidence!.conversations, r.evidence!.revisions, r.confidence, r.aligned])).toEqual([
      ["User prefers short captions", 2, 2, 0, 0.8, true],
      ["User prefers dark mode everywhere", 1, 1, 1, 0.7, true],
      ["User works late", 1, 1, 0, 0.7, true],
    ]);
  });

  it("12. a failed evidence calculation leaves the prior memory unchanged in every field and writes nothing", async () => {
    const u = await newUser("fail");
    await say(u, await newConversation(u), "I prefer short captions.", SHORT);
    const before = await rows(u);

    resolve.mockImplementation(() => {
      throw new Error("evidence exploded");
    });
    const { logged } = await say(u, await newConversation(u), "I prefer short captions. I work late.", [
      ["User prefers short captions", "I prefer short captions"],
      ["User works late", "I work late"],
    ]);

    expect(await rows(u)).toEqual(before);
    expect(logged.filter((l) => l.includes("memory_learning_evidence_failed"))).toEqual([JSON.stringify({ event: "memory_learning_evidence_failed" })]);
  });

  it("evidence cannot cross users: the same statement from another user is that user's own memory; the first is untouched", async () => {
    const a = await newUser("iso-a");
    const b = await newUser("iso-b");
    await say(a, await newConversation(a), "I prefer short captions.", SHORT);
    const aBefore = await rows(a);

    await say(b, await newConversation(b), "I prefer short captions.", SHORT);

    expect(await rows(a)).toEqual(aBefore);
    const bRows = await rows(b);
    expect(bRows).toHaveLength(1);
    expect(bRows[0]!.evidence).toMatchObject({ count: 1, conversations: 1 });
    expect(bRows[0]!.id).not.toBe(aBefore[0]!.id);
  });

  it("evidence holds no content: no user words, claim or reply in the stored evidence", async () => {
    const u = await newUser("content");
    await say(u, await newConversation(u), "I prefer short captions.", SHORT);
    await say(u, await newConversation(u), "I prefer short captions.", SHORT);

    const text = JSON.stringify((await rows(u))[0]!.evidence);
    for (const forbidden of ["short", "captions", "prefer", "Noted"]) expect(text, forbidden).not.toContain(forbidden);
  });
});

describe.skipIf(!dbUp)("S7.2 L4.1 — negation (PostgreSQL)", () => {
  const REPORT: Array<[string, string]> = [
    ["User prefers to receive the weekly performance report every Monday morning", "I prefer to receive the weekly performance report every Monday morning"],
  ];
  const NOT_REPORT: Array<[string, string]> = [
    ["User prefers not to receive the weekly performance report every Monday morning", "I prefer not to receive the weekly performance report every Monday morning"],
  ];
  const POSITIVE = "I prefer to receive the weekly performance report every Monday morning.";

  it("a negated statement is NOT a corroboration: the positive memory keeps its evidence, confidence and expiry, and gains no source", async () => {
    const u = await newUser("negation");
    await say(u, await newConversation(u), POSITIVE, REPORT);
    await say(u, await newConversation(u), POSITIVE, REPORT);
    // A short expiry, so a corroboration's refresh to 90 days could not go unseen.
    await prisma!.$executeRawUnsafe(`UPDATE "Memory" SET "expiresAt" = now() + interval '1 day' WHERE "userId" = $1`, u);
    const [positive] = await rows(u);
    expect(positive!.evidence).toMatchObject({ count: 2, conversations: 2 });
    expect(positive!.confidence).toBe(0.8);

    const negated = await say(u, await newConversation(u), "I prefer not to receive the weekly performance report every Monday morning.", NOT_REPORT);

    const list = await rows(u);
    expect(list).toHaveLength(2);
    const after = list.find((r) => r.id === positive!.id)!;
    expect(after.evidence!.count, "evidence count unchanged").toBe(2);
    expect(after.confidence, "confidence unchanged").toBe(0.8);
    expect(after.expiresAt, "expiry unchanged").toEqual(positive!.expiresAt);
    expect(after.evidence!.sources.map((s) => s.messageId), "no source from the negated turn").not.toContain(negated.messageId);
    expect(after, "the positive memory is untouched in every column").toEqual(positive);

    const fresh = list.find((r) => r.id !== positive!.id)!;
    expect(fresh.content).toBe("User prefers not to receive the weekly performance report every Monday morning");
    expect(fresh.evidence).toMatchObject({ count: 1, conversations: 1, revisions: 0 });
    expect(fresh.evidence!.sources.map((s) => s.messageId)).toEqual([negated.messageId]);
    expect(fresh.confidence).toBe(0.7);
    expect(fresh.aligned).toBe(true);

    // Control: the positive statement itself still corroborates the positive memory.
    await say(u, await newConversation(u), POSITIVE, REPORT);
    const control = (await rows(u)).find((r) => r.id === positive!.id)!;
    expect(control.evidence).toMatchObject({ count: 3, conversations: 3 });
    expect(control.confidence).toBe(0.9);
  });

  it("the vector path: an identical vector across a negation is a revision, not a corroboration — and the revision is correct", async () => {
    const u = await newUser("negation-revise");
    const first = await say(u, await newConversation(u), "I like spicy food.", [["User likes spicy food", "I like spicy food"]]);
    await say(u, await newConversation(u), "I like spicy food.", [["User likes spicy food", "I like spicy food"]]);
    const [before] = await rows(u);
    expect(before!.confidence).toBe(0.8);

    const conv = await newConversation(u);
    const t0 = Date.now();
    const negated = await say(u, conv, "I do not like spicy food.", [["User does not like spicy food", "I do not like spicy food"]]);

    const list = await rows(u);
    expect(list).toHaveLength(1);
    const row = list[0]!;
    expect(row.id).toBe(before!.id);
    expect(row.content).toBe("User does not like spicy food");
    expect(row.confidence, "derived from the new statement — the old 0.80 is not raised").toBe(0.7);
    expect(row.evidence).toMatchObject({ count: 1, conversations: 1, revisions: 1, previousSourceMessageIds: [first.messageId] });
    expect(row.evidence!.sources.map((s) => [s.messageId, s.conversationId])).toEqual([[negated.messageId, conv]]);
    expect(row.aligned).toBe(true);
    expect(row.expiresAt!.getTime()).toBeGreaterThanOrEqual(t0 + 90 * DAY - 60_000);
  });
});
