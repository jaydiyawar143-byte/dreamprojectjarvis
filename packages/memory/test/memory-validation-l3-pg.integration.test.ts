// S7.2 L3 — validation against the REAL repositories and PostgreSQL + pgvector.
//
// Each turn is saved as the chat route saves it (Conversation + the user's
// Message), then extracted. Every assertion reads the database back. Where a
// candidate must NOT touch memory, an earlier memory CLOSE to it (cosine 0.8,
// inside the merge range) is seeded first, and compared field by field — the
// VALID control proves the same seed WOULD be merged, so "unchanged" means L3
// stopped it, not that nothing was near.
//
// SAFETY. DATABASE_URL is read BEFORE anything imports the Prisma client
// (which loads packages/db/.env on import). The suite runs only against an
// explicitly supplied, separate test database; otherwise it is skipped.
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import type { EmbeddingRequest, EmbeddingResponse, IAIProvider, IEmbeddingProvider } from "@jarvis/core";

vi.mock("@jarvis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jarvis/core")>();
  return { ...actual, validateLearningCandidate: vi.fn(actual.validateLearningCandidate) };
});

import { validateLearningCandidate } from "@jarvis/core";
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

const validate = vi.mocked(validateLearningCandidate);
const realValidate = (await vi.importActual<typeof import("@jarvis/core")>("@jarvis/core")).validateLearningCandidate;

const DIMS = 1536;
const STAMP = Date.now();
const userIds: string[] = [];
const conversationIds: string[] = [];
const basis = (i: number) => Array.from({ length: DIMS }, (_, k) => (k === i ? 1 : 0));
/** cosine 0.8 with basis(1) — the first candidate's embedding: inside the merge range. */
const NEAR_FIRST = Array.from({ length: DIMS }, (_, k) => (k === 1 ? 0.8 : k === 2 ? 0.6 : 0));
const toSql = (v: number[]) => `[${v.join(",")}]`;

function model(candidates: Array<Record<string, unknown>>): IAIProvider {
  return {
    id: "l3-model",
    name: "L3 model",
    defaultModel: "l3",
    async complete() {
      return { message: { role: "assistant", content: JSON.stringify({ candidates }) }, finishReason: "stop", model: "l3" };
    },
    async listModels() {
      return ["l3"];
    },
    async isAvailable() {
      return true;
    },
  };
}

const embeddings: IEmbeddingProvider = {
  id: "l3-embeddings",
  name: "L3 embeddings",
  dimensions: DIMS,
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return { embeddings: inputs.map((_, i) => basis(i + 1)), model: "l3" };
  },
  async isAvailable() {
    return true;
  },
};

const pref = (content: string, evidence: string, source = "M1") => ({ type: "PREFERENCE", content, importance: 0.8, confidence: 0.9, source, evidence });

const ROWS = `SELECT m."id", m."content", m."type"::text AS "type", m."importance", m."confidence", m."sourceType",
                     m."sourceConversationId", m."sourceMessageId", m."metadata"::text AS "metadata",
                     m."embedding"::text AS "vector", m."updatedAt",
                     msg."role" AS "sourceRole",
                     CASE WHEN m."embedding" IS NOT NULL AND jsonb_typeof(m."metadata"->'embedding') = 'array'
                          THEN m."embedding" = (m."metadata"->'embedding')::text::vector END AS "metadataEqualsVector"
                FROM "Memory" m LEFT JOIN "Message" msg ON msg."id" = m."sourceMessageId"
               WHERE m."userId" = $1 ORDER BY m."createdAt", m."content"`;

/** A chat turn saved as the chat route saves it, optionally beside an earlier memory; then extraction. */
async function turn(tag: string, userText: string, candidates: Array<Record<string, unknown>>, withEarlier = false) {
  const user = await prisma!.user.create({
    data: { email: `s7-l3-${tag}-${STAMP}-${userIds.length}@jarvis-test.local`, name: `L3 ${tag}`, password: "not-a-real-password-hash", role: "VIEWER" },
  });
  userIds.push(user.id);
  if (withEarlier) {
    const earlier = await prisma!.memory.create({
      data: {
        userId: user.id,
        type: "PREFERENCE",
        content: "L3 earlier: likes brief captions",
        importance: 0.7,
        confidence: 0.9,
        sourceType: "USER",
        metadata: { embedding: NEAR_FIRST },
      },
    });
    await prisma!.$executeRawUnsafe('UPDATE "Memory" SET "embedding" = $1::vector WHERE "id" = $2', toSql(NEAR_FIRST), earlier.id);
  }
  const before = await prisma!.$queryRawUnsafe<Array<Record<string, unknown>>>(ROWS, user.id);

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
  const logged: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  try {
    await service.extract({
      userId: user.id,
      conversationId: conversation.id,
      messages: [
        { role: "user", content: userText, messageId: saved.id, traceId },
        { role: "assistant", content: "Your default style is short captions." },
      ],
      expiryDays: 90,
    });
  } finally {
    spy.mockRestore();
  }
  const after = await prisma!.$queryRawUnsafe<Array<Record<string, unknown>>>(ROWS, user.id);
  const events = logged.flatMap((l) => {
    try {
      const e = JSON.parse(l) as Record<string, unknown>;
      return typeof e.event === "string" && e.event.includes("validation") ? [e] : [];
    } catch {
      return [];
    }
  });
  return { before, after, events, conversationId: conversation.id, messageId: saved.id, traceId };
}

afterEach(() => {
  validate.mockReset();
  validate.mockImplementation(realValidate);
});

afterAll(async () => {
  if (dbUp) {
    await prisma!.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await prisma!.conversation.deleteMany({ where: { id: { in: conversationIds } } });
    if (userIds.length > 0) await prisma!.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma?.$disconnect();
});

describe.skipIf(!dbUp)("S7.2 L3 — validation (PostgreSQL)", () => {
  it("VALID: exactly one memory, USER provenance joined to the saved message, vector = metadata embedding", async () => {
    const { after, conversationId, messageId } = await turn("valid", "I prefer short captions.", [
      pref("User prefers short captions", "I prefer short captions"),
    ]);

    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      content: "User prefers short captions",
      type: "PREFERENCE",
      importance: 0.8,
      confidence: 0.9,
      sourceType: "USER",
      sourceConversationId: conversationId,
      sourceMessageId: messageId,
      sourceRole: "user",
      metadataEqualsVector: true,
    });
  });

  it("control: the same VALID candidate beside the close earlier memory merges into it (the seed is in range)", async () => {
    const { before, after, messageId } = await turn(
      "valid-merge",
      "I prefer short captions.",
      [pref("User prefers short captions", "I prefer short captions")],
      true
    );

    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[0]).toMatchObject({ content: "User prefers short captions", sourceMessageId: messageId, metadataEqualsVector: true });
  });

  it.each([
    ["HOLD (weak acknowledgement)", "Thanks, sounds good.", pref("User prefers short captions", "Thanks, sounds good."), "HOLD"],
    ["HOLD (uncertain)", "Maybe I prefer short captions.", pref("User prefers short captions", "I prefer short captions"), "HOLD"],
    ["INVALID (general statement)", "Clients prefer short captions.", pref("User prefers short captions", "prefer short captions"), "INVALID"],
    ["INVALID (claim not supported)", "I prefer short captions.", pref("User prefers dark mode", "I prefer short captions"), "INVALID"],
  ])("%s: zero rows created, the close earlier memory unchanged in every field", async (_label, text, candidate, decision) => {
    const { before, after, events } = await turn("rejected", text, [candidate], true);

    expect(after).toEqual(before);
    expect(after).toHaveLength(1);
    expect(events.map((e) => e.decision)).toEqual([decision]);
  });

  // L3 finalization — not memory, whatever the model extracts.
  it.each([
    ["GOAL", "I want to launch my SaaS by Q3.", pref("User wants to launch their SaaS by Q3", "I want to launch my SaaS by Q3")],
    ["TASK", "Remind me to call the client.", pref("Remind user to call the client", "Remind me to call the client")],
    ["PROJECT", "The current project uses Next.js.", pref("User's current project uses Next.js", "The current project uses Next.js")],
    ["DECISION", "I decided to use PostgreSQL.", pref("User decided to use PostgreSQL", "I decided to use PostgreSQL")],
    ["TEMPORARY", "For today's post use this style.", pref("User prefers this style", "use this style")],
  ])("%s: zero Memory rows, the close earlier memory unchanged in every field", async (scope, text, candidate) => {
    const { before, after, events } = await turn(`scope-${scope.toLowerCase()}`, text, [candidate], true);

    expect(after).toEqual(before);
    expect(after).toHaveLength(1);
    expect(events.map((e) => [e.decision, e.scope])).toEqual([["INVALID", scope]]);
  });

  it("mixed batch: only the VALID candidate persists", async () => {
    const { after, messageId } = await turn("mixed", "I prefer short captions.", [
      pref("User prefers short captions", "I prefer short captions"),
      pref("User always prefers short captions", "I prefer short captions"),
      pref("User prefers dark mode", "I prefer short captions"),
      pref("User's default style is short captions", "Your default style is short captions", "M2"),
    ]);

    expect(after.map((r) => [r.content, r.sourceMessageId, r.sourceRole, r.metadataEqualsVector])).toEqual([
      ["User prefers short captions", messageId, "user", true],
    ]);
  });

  it("validator failure: no write, no update — the close earlier memory is unchanged", async () => {
    validate.mockImplementation(() => {
      throw new Error("validator exploded");
    });
    const { before, after, events } = await turn("failure", "I prefer short captions.", [pref("User prefers short captions", "I prefer short captions")], true);

    expect(after).toEqual(before);
    expect(events).toEqual([{ event: "memory_learning_validation_failed" }]);
  });
});
