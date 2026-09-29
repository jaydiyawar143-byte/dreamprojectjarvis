// S7.2 L2 Step 1 — memory provenance against the REAL repositories and
// PostgreSQL + pgvector.
//
// Each turn is saved exactly as the chat route saves it: a real Conversation,
// the user's Message with { traceId } metadata, then extraction with the saved
// message's id. Every assertion reads the database back, and the memory's
// source is JOINED to the Message table — so "points at the user's message"
// means a real row with role 'user', not just a matching string.
//
// SAFETY. DATABASE_URL is read BEFORE anything imports the Prisma client
// (which loads packages/db/.env on import). The suite runs only against an
// explicitly supplied, separate test database; otherwise it is skipped.
import { describe, it, expect, afterAll, vi } from "vitest";
import type { EmbeddingRequest, EmbeddingResponse, IAIProvider, IEmbeddingProvider } from "@jarvis/core";
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

const DIMS = 1536;
const STAMP = Date.now();
const userIds: string[] = [];
const conversationIds: string[] = [];
const basis = (i: number) => Array.from({ length: DIMS }, (_, k) => (k === i ? 1 : 0));

function model(candidates: Array<Record<string, unknown>>): IAIProvider {
  return {
    id: "l2-model",
    name: "L2 model",
    defaultModel: "l2",
    async complete() {
      return { message: { role: "assistant", content: JSON.stringify({ candidates }) }, finishReason: "stop", model: "l2" };
    },
    async listModels() {
      return ["l2"];
    },
    async isAvailable() {
      return true;
    },
  };
}

/** Candidate i gets basis vector i+1: distinct, orthogonal, never merging with each other. */
const embeddings: IEmbeddingProvider = {
  id: "l2-embeddings",
  name: "L2 embeddings",
  dimensions: DIMS,
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return { embeddings: inputs.map((_, i) => basis(i + 1)), model: "l2" };
  },
  async isAvailable() {
    return true;
  },
};

const pref = (content: string, citation: Record<string, unknown>) => ({ type: "PREFERENCE", content, importance: 0.8, confidence: 0.9, ...citation });

/** A chat turn saved as the chat route saves it, then extraction; returns what landed in Memory. */
async function turn(tag: string, userText: string, reply: string, candidates: Array<Record<string, unknown>>) {
  const user = await prisma!.user.create({
    data: { email: `s7-l2-${tag}-${STAMP}-${userIds.length}@jarvis-test.local`, name: `L2 ${tag}`, password: "not-a-real-password-hash", role: "VIEWER" },
  });
  userIds.push(user.id);
  const conversations = new db!.PrismaConversationRepository(prisma!);
  const conversation = await conversations.create({ userId: user.id });
  conversationIds.push(conversation.id);
  const traceId = `00000000-0000-4000-8000-${String(userIds.length).padStart(12, "0")}`;
  const saved = await conversations.addMessage({ conversationId: conversation.id, role: "user", content: userText, metadata: { traceId } });

  const service = new MemoryExtractionService({
    aiProvider: model(candidates),
    store: new db!.PrismaMemoryRepository(prisma!),
    embeddingProvider: embeddings,
    maxRetries: 0,
  });
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await service.extract({
      userId: user.id,
      conversationId: conversation.id,
      messages: [
        { role: "user", content: userText, messageId: saved.id, traceId },
        { role: "assistant", content: reply },
      ],
      expiryDays: 90,
    });
  } finally {
    spy.mockRestore();
  }

  const rows = await prisma!.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT m."content", m."type"::text AS "type", m."importance", m."confidence",
            m."sourceType", m."sourceConversationId", m."sourceMessageId",
            m."metadata"->>'sourceTraceId' AS "sourceTraceId",
            msg."role" AS "sourceRole", msg."content" AS "sourceContent", msg."metadata"->>'traceId' AS "sourceMessageTrace",
            (m."embedding" IS NOT NULL) AS "hasVector",
            CASE WHEN m."embedding" IS NOT NULL AND jsonb_typeof(m."metadata"->'embedding') = 'array'
                 THEN m."embedding" = (m."metadata"->'embedding')::text::vector END AS "metadataEqualsVector",
            round(extract(epoch FROM (m."expiresAt" - m."createdAt")) / 86400)::int AS "expiryDays"
       FROM "Memory" m LEFT JOIN "Message" msg ON msg."id" = m."sourceMessageId"
      WHERE m."userId" = $1 ORDER BY m."content"`,
    user.id
  );
  return { rows, conversationId: conversation.id, messageId: saved.id, traceId };
}

afterAll(async () => {
  if (dbUp) {
    await prisma!.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await prisma!.conversation.deleteMany({ where: { id: { in: conversationIds } } });
    if (userIds.length > 0) await prisma!.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma?.$disconnect();
});

describe.skipIf(!dbUp)("S7.2 L2 — memory provenance (PostgreSQL)", () => {
  it("a USER-origin candidate creates exactly one memory that joins back to the user's saved message", async () => {
    const { rows, conversationId, messageId, traceId } = await turn(
      "user",
      "I prefer short captions.",
      "Great, I'll remember that you prefer short captions.",
      [pref("User prefers short captions", { source: "M1", evidence: "I prefer short captions" })]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      content: "User prefers short captions",
      type: "PREFERENCE",
      importance: 0.8,
      confidence: 0.9,
      sourceType: "USER",
      sourceConversationId: conversationId,
      sourceMessageId: messageId,
      sourceTraceId: traceId,
      sourceRole: "user",
      sourceContent: "I prefer short captions.",
      sourceMessageTrace: traceId,
      hasVector: true,
      metadataEqualsVector: true,
      expiryDays: 90,
    });
  });

  it.each([
    ["cited to JARVIS's reply", { source: "M2", evidence: "your default style is short captions" }],
    ["cited to the user, quoting JARVIS", { source: "M1", evidence: "your default style is short captions" }],
    ["with no source", {}],
  ])("an assistant-only claim %s creates zero memory rows", async (_label, citation) => {
    const { rows } = await turn(
      "assistant-only",
      "Thanks, sounds good.",
      "I've decided that your default style is short captions.",
      [pref("L2: default style is short captions", citation)]
    );

    expect(rows).toEqual([]);
  });

  it("an explicit endorsement's memory points at the endorsement message, not at JARVIS's reply", async () => {
    const { rows, messageId } = await turn(
      "endorse",
      "Yes, make that my default.",
      "Your default is short captions.",
      [pref("L2: default caption style is short captions", { source: "M1", evidence: "make that my default" })]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceType: "USER",
      sourceMessageId: messageId,
      sourceRole: "user",
      sourceContent: "Yes, make that my default.",
      hasVector: true,
      metadataEqualsVector: true,
    });
  });

  it("in a mixed batch only the USER-sourced candidate is stored, with its own vector", async () => {
    const { rows, messageId } = await turn("mixed", "I work late on Fridays.", "Your default channel is LinkedIn.", [
      pref("L2: default channel is LinkedIn", { source: "M2", evidence: "Your default channel is LinkedIn" }),
      pref("User works late on Fridays", { source: "M1", evidence: "I work late on Fridays" }),
    ]);

    expect(rows.map((r) => [r.content, r.sourceMessageId, r.sourceRole, r.metadataEqualsVector])).toEqual([
      ["User works late on Fridays", messageId, "user", true],
    ]);
  });
});
