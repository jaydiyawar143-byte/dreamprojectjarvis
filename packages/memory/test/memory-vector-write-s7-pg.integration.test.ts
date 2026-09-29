// S7 Step 4 — memory write-path repair contract, against REAL PostgreSQL +
// pgvector. TESTS FIRST: written before the repair and expected to FAIL against
// the current implementation (S7 Step 1: extraction never writes the vector
// column; S7 Step 3: a merge leaves the vector describing the old content).
//
// Runs the REAL MemoryExtractionService with the REAL PrismaMemoryRepository.
// The chat model and the embedding provider are deterministic stand-ins: the
// model returns a fixed candidate list, the embedder returns fixed 1536-d unit
// vectors. No network, no sleeps. Every assertion reads PostgreSQL directly and
// selects only computed values, never the raw vector column.
//
// SAFETY. These tests run ONLY when DATABASE_URL is explicitly set in the
// environment — point it at a separate test database, never the development
// one (AGENTS.md). Otherwise the whole suite is skipped. Dedicated users are
// removed afterwards; Memory cascades from User.
//
// S7 Step 8 correction: the Prisma client loads packages/db/.env as soon as it
// is imported, so DATABASE_URL is now read BEFORE @jarvis/db is (dynamically)
// imported. Checked after a static import, it was always set — to the
// development database — and only an unreachable server kept this suite off it.
import { describe, it, expect, afterAll } from "vitest";
import type {
  AICompletionRequest,
  AICompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  IAIProvider,
  IEmbeddingProvider,
} from "@jarvis/core";
import { MemoryExtractionService } from "../src/memory-extraction-service.js";
import { citeFirstUserMessage } from "./helpers/compliant-citation.js";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const { PrismaClient, PrismaMemoryRepository } = await import("@jarvis/db");

const prisma = new PrismaClient();

let dbUp = false;
if (EXPLICIT_DATABASE_URL) {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const STAMP = Date.now();
const DIMS = 1536;
const userIds: string[] = [];
const toSql = (v: number[]) => `[${v.join(",")}]`;
const inDays = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

function unit(components: Record<number, number>): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const [i, x] of Object.entries(components)) v[Number(i)] = x;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

// ---------------------------------------------------------------------------
// Deterministic stand-ins
// ---------------------------------------------------------------------------

/** Returns one fixed extraction response. */
class ScriptedExtractionModel implements IAIProvider {
  readonly id = "s7-scripted-model";
  readonly name = "S7 scripted extraction model";
  readonly defaultModel = "s7-scripted";
  constructor(private readonly candidates: Array<Record<string, unknown>>) {}
  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    return {
      // S7.2 L2 — a compliant model: each candidate cites the user's message.
      message: { role: "assistant", content: citeFirstUserMessage(request, JSON.stringify({ candidates: this.candidates })) },
      finishReason: "stop",
      model: this.defaultModel,
    };
  }
  async listModels(): Promise<string[]> {
    return [this.defaultModel];
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

/** Fixed vector per known text; any other text gets a fixed fallback direction. */
class FixedEmbeddingProvider implements IEmbeddingProvider {
  readonly id = "s7-fixed-embedding";
  readonly name = "S7 fixed embedding provider";
  readonly dimensions = DIMS;
  constructor(private readonly vectors: Map<string, number[]>) {}
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return {
      embeddings: inputs.map((text) => this.vectors.get(text) ?? unit({ 1535: 1 })),
      model: "s7-fixed",
    };
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

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

/** Vector facts of every memory a user has, computed in SQL (the raw vector is never selected). */
async function vectorFacts(userId: string, compareWith: number[][]) {
  const comparisons = compareWith
    .map((_, i) => `CASE WHEN "embedding" IS NULL THEN NULL ELSE 1 - ("embedding" <=> $${i + 2}::vector) END AS "vectorVs${i}",
       CASE WHEN "metadata" ? 'embedding' THEN 1 - (("metadata"->'embedding')::text::vector <=> $${i + 2}::vector) ELSE NULL END AS "metadataVs${i}"`)
    .join(",\n       ");
  return prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "id", "content",
       ("embedding" IS NOT NULL) AS "hasVector",
       CASE WHEN "embedding" IS NULL THEN NULL ELSE vector_dims("embedding") END AS "vectorDims",
       coalesce("metadata" ? 'embedding', false) AS "hasMetadataEmbedding",
       CASE WHEN "metadata" ? 'embedding' THEN jsonb_array_length("metadata"->'embedding') ELSE NULL END AS "metadataLength",
       CASE WHEN "embedding" IS NOT NULL AND "metadata" ? 'embedding'
            THEN 1 - (("metadata"->'embedding')::text::vector <=> "embedding") ELSE NULL END AS "metadataVsVector"${comparisons ? ",\n       " + comparisons : ""}
     FROM "Memory" WHERE "userId" = $1 ORDER BY "createdAt"`,
    userId,
    ...compareWith.map(toSql)
  );
}

afterAll(async () => {
  if (dbUp && userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Part 3 — extraction writes the vector AND keeps the metadata embedding
// ---------------------------------------------------------------------------

describe.skipIf(!dbUp)("S7 memory write contract — MemoryExtractionService + PrismaMemoryRepository (PostgreSQL)", () => {
  it("newly extracted memory writes both vector column and metadata embedding", async () => {
    const user = await newUser("t10");
    const content = "User prefers S7 contract reports as a short PDF.";
    const vector = unit({ 5: 1 });

    const service = new MemoryExtractionService({
      aiProvider: new ScriptedExtractionModel([{ type: "PREFERENCE", content, importance: 0.8, confidence: 1 }]),
      store: new PrismaMemoryRepository(prisma),
      embeddingProvider: new FixedEmbeddingProvider(new Map([[content, vector]])),
      maxRetries: 0,
    });

    await service.extract({
      userId: user,
      conversationId: "conv-s7-t10",
      messages: [{ role: "user", messageId: "msg-s7-t10", content: "Please remember that I prefer S7 contract reports as a short PDF." }],
      expiryDays: 90,
    });

    const rows = await vectorFacts(user, [vector]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.content).toBe(content);
    expect(row.hasVector, "the pgvector column is populated").toBe(true);
    expect(Number(row.vectorDims)).toBe(DIMS);
    expect(row.hasMetadataEmbedding, "metadata.embedding is kept during this repair").toBe(true);
    expect(Number(row.metadataLength)).toBe(DIMS);
    expect(Number(row.metadataVsVector), "metadata embedding matches the vector").toBeGreaterThanOrEqual(0.999999);
    expect(Number(row.vectorVs0), "the vector is the candidate's embedding").toBeGreaterThanOrEqual(0.999999);
  });

  // -------------------------------------------------------------------------
  // Part 4 — a merge keeps the vector in step with the merged content
  // -------------------------------------------------------------------------

  it("memory merge updates vector together with merged content", async () => {
    const user = await newUser("t11");
    const contentA = "User prefers S7 merge reports as PDF in Hindi.";
    const contentB = "User wants weekly S7 merge summaries as slides in English.";
    const vectorA = unit({ 10: 1 });
    // cos(A, B) = 0.8: inside the extraction merge range [0.7, 0.95), and the two
    // texts share too few words (5 of 10) to trip the 0.85 text-overlap skip.
    const vectorB = unit({ 10: 0.8, 11: 0.6 });

    // Existing memory A in the post-repair shape (vector + metadata), inserted
    // directly so this test does not depend on the write path under repair.
    const existing = await prisma.memory.create({
      data: {
        userId: user,
        type: "PREFERENCE",
        content: contentA,
        importance: 0.8,
        confidence: 1,
        sourceType: "s7-test",
        metadata: { embedding: vectorA },
        expiresAt: inDays(90),
      },
    });
    await prisma.$executeRawUnsafe('UPDATE "Memory" SET "embedding" = $1::vector WHERE "id" = $2', toSql(vectorA), existing.id);

    const service = new MemoryExtractionService({
      aiProvider: new ScriptedExtractionModel([{ type: "PREFERENCE", content: contentB, importance: 0.8, confidence: 1 }]),
      store: new PrismaMemoryRepository(prisma),
      embeddingProvider: new FixedEmbeddingProvider(new Map([[contentB, vectorB]])),
      maxRetries: 0,
    });

    const result = await service.extract({
      userId: user,
      conversationId: "conv-s7-t11",
      messages: [{ role: "user", messageId: "msg-s7-t11", content: "Actually, I want weekly S7 merge summaries as slides in English." }],
      expiryDays: 90,
    });
    expect(result.meta.memoriesUpdated, "the existing path merged rather than created").toBe(1);

    const rows = await vectorFacts(user, [vectorA, vectorB]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(existing.id);
    expect(row.content).toBe(contentB);
    expect(Number(row.metadataVs1), "metadata embedding is B").toBeGreaterThanOrEqual(0.999999);
    expect(Number(row.vectorVs1), "the vector represents B").toBeGreaterThanOrEqual(0.999999);
    expect(Number(row.vectorVs0), "the vector is no longer A").toBeLessThan(0.999);
  });
});
