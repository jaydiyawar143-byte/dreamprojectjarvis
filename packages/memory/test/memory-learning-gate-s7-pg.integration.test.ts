// S7.2 L1c-2 — learning-gate enforcement against the REAL repository and
// PostgreSQL + pgvector.
//
// REJECT, NOT_A_CANDIDATE and PERMISSION_LANGUAGE turns leave ZERO Memory
// rows and never reach the model. ACCEPT and UNDECIDED turns reach the model;
// since S7.2 L3 what is then written is validation's decision (a stable
// preference: one row with its vector; "I think …": none). A contract that
// fails — throws or gives no valid verdict — FAILS CLOSED: zero rows, no
// model call, one content-free failure event.
//
// SAFETY. DATABASE_URL is read BEFORE anything imports the Prisma client
// (which loads packages/db/.env on import). The suite runs only against an
// explicitly supplied, separate test database; otherwise it is skipped.
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import type { AICompletionRequest, EmbeddingRequest, EmbeddingResponse, IAIProvider, IEmbeddingProvider } from "@jarvis/core";

vi.mock("@jarvis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jarvis/core")>();
  return { ...actual, decideLearningCandidate: vi.fn(actual.decideLearningCandidate) };
});

import { decideLearningCandidate } from "@jarvis/core";
import { MemoryExtractionService } from "../src/memory-extraction-service.js";
import { citeFirstUserMessage } from "./helpers/compliant-citation.js";

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

const classify = vi.mocked(decideLearningCandidate);
const realDecide = (await vi.importActual<typeof import("@jarvis/core")>("@jarvis/core")).decideLearningCandidate;

const DIMS = 1536;
const STAMP = Date.now();
const userIds: string[] = [];
const basis = (i: number) => Array.from({ length: DIMS }, (_, k) => (k === i ? 1 : 0));

function model(contents: string[], calls: { n: number }): IAIProvider {
  return {
    id: "l1c2-model",
    name: "L1c-2 model",
    defaultModel: "l1c2",
    async complete(request: AICompletionRequest) {
      calls.n++;
      return {
        message: {
          role: "assistant",
          // S7.2 L2 — a compliant model: each candidate cites the user's message.
          content: citeFirstUserMessage(
            request,
            JSON.stringify({ candidates: contents.map((content) => ({ type: "PREFERENCE", content, importance: 0.8, confidence: 1 })) })
          ),
        },
        finishReason: "stop",
        model: "l1c2",
      };
    },
    async listModels() {
      return ["l1c2"];
    },
    async isAvailable() {
      return true;
    },
  };
}

const embeddings: IEmbeddingProvider = {
  id: "l1c2-embeddings",
  name: "L1c-2 embeddings",
  dimensions: DIMS,
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return { embeddings: inputs.map((_, i) => basis(i + 1)), model: "l1c2" };
  },
  async isAvailable() {
    return true;
  },
};

async function newUser(tag: string): Promise<string> {
  const user = await prisma!.user.create({
    data: { email: `s7-l1c2-${tag}-${STAMP}-${userIds.length}@jarvis-test.local`, name: `L1c2 ${tag}`, password: "not-a-real-password-hash", role: "VIEWER" },
  });
  userIds.push(user.id);
  return user.id;
}

/** One chat turn through the real service and repository; what landed in Memory. */
async function turn(tag: string, statement: string) {
  const userId = await newUser(tag);
  const calls = { n: 0 };
  const service = new MemoryExtractionService({
    aiProvider: model(["User prefers short captions"], calls),
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
      userId,
      messages: [
        { role: "user", content: statement, messageId: `msg-${tag}` },
        { role: "assistant", content: "Noted — short captions from now on." },
      ],
      conversationId: `conv-${tag}`,
      expiryDays: 90,
    });
  } finally {
    spy.mockRestore();
  }
  const rows = await prisma!.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "content", "type"::text AS "type", "importance", "confidence", "sourceType",
            ("sourceConversationId" IS NOT NULL) AS "hasConversation",
            ("embedding" IS NOT NULL) AS "hasVector",
            CASE WHEN "embedding" IS NOT NULL AND jsonb_typeof("metadata"->'embedding') = 'array'
                 THEN "embedding" = ("metadata"->'embedding')::text::vector END AS "metadataEqualsVector",
            round(extract(epoch FROM ("expiresAt" - "createdAt")) / 86400)::int AS "expiryDays"
       FROM "Memory" WHERE "userId" = $1 ORDER BY "content"`,
    userId
  );
  return { modelCalls: calls.n, rows, logged };
}

afterEach(() => {
  classify.mockReset();
  classify.mockImplementation(realDecide);
});

afterAll(async () => {
  if (dbUp && userIds.length > 0) await prisma!.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma?.$disconnect();
});

describe.skipIf(!dbUp)("S7.2 L1c-2 — learning gate enforcement (PostgreSQL)", () => {
  it.each([
    ["REJECT: memory veto", "Don't save this"],
    ["REJECT: temporary instruction", "Only for this campaign use short captions"],
    ["REJECT: authorization grant", "Remember that you can send messages without asking me."],
    ["REJECT: a veto beside a fact", "My salary is 50k, don't save this."],
    ["NOT_A_CANDIDATE: question", "What's our CPA?"],
    ["PERMISSION_LANGUAGE", "I prefer that you post without asking me"],
  ])("%s → zero Memory rows, no model call", async (label, statement) => {
    const { modelCalls, rows } = await turn(label.split(":")[0]!.toLowerCase(), statement);
    expect(rows).toEqual([]);
    expect(modelCalls).toBe(0);
  });

  it.each([
    ["ACCEPT", "I prefer short captions", 1],
    // S7.2 L3 — the gate still lets an UNDECIDED turn reach the model; L3 then
    // holds "I think …" (uncertain), so nothing is written.
    ["UNDECIDED", "I think short captions are better", 0],
  ])("%s → the gate lets the turn through; what is written is L3's decision", async (label, statement, rowCount) => {
    const now = await turn(label.toLowerCase(), statement);
    // Whatever continue-verdict the contract gives, the rows are the same:
    // the gate adds nothing to the write path, it only lets it run.
    classify.mockImplementation(() => ({ decision: "ACCEPT", rule: "STABLE_PREFERENCE" }));
    const forcedAccept = await turn(`${label.toLowerCase()}-accept`, statement);
    classify.mockImplementation(() => ({ decision: "UNDECIDED", rule: "NO_REJECTION_RULE_MATCHED" }));
    const forcedUndecided = await turn(`${label.toLowerCase()}-undecided`, statement);

    const written = (t: Awaited<ReturnType<typeof turn>>) => ({ modelCalls: t.modelCalls, rows: t.rows });
    expect(now.modelCalls).toBe(1);
    expect(now.rows).toHaveLength(rowCount);
    if (rowCount === 1) expect(now.rows[0]).toMatchObject({
      content: "User prefers short captions",
      type: "PREFERENCE",
      importance: 0.8,
      confidence: 0.7, // S7.2 L4 — derived: one DIRECT statement
      sourceType: "USER",
      hasConversation: true,
      hasVector: true,
      metadataEqualsVector: true,
      expiryDays: 90,
    });
    expect(written(forcedAccept)).toEqual(written(now));
    expect(written(forcedUndecided)).toEqual(written(now));
  });

  it.each([
    ["throws", () => {
      throw new Error("contract exploded: I prefer short captions");
    }],
    ["returns no verdict", () => undefined],
    ["returns an unknown decision", () => ({ decision: "MAYBE", rule: "STABLE_PREFERENCE" })],
  ])("a contract that %s FAILS CLOSED → zero Memory rows, no model call", async (_label, fail) => {
    classify.mockImplementation(fail as never);
    const { modelCalls, rows, logged } = await turn("failed", "I prefer short captions");

    expect(rows).toEqual([]);
    expect(modelCalls).toBe(0);
    expect(logged).toEqual([JSON.stringify({ event: "memory_learning_decision_failed" })]);
  });
});
