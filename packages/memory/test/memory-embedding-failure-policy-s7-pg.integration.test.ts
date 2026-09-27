// S7 Step 8 — embedding failure policy against the REAL repository and
// PostgreSQL + pgvector: a candidate without a valid, storable embedding
// leaves NO Memory row, and a database-rejected vector rolls back fully.
//
// SAFETY. DATABASE_URL is read BEFORE anything imports the Prisma client,
// because the client loads packages/db/.env on import and would otherwise
// silently point this suite at the development database. The suite runs only
// when DATABASE_URL was set explicitly for a separate test database
// (AGENTS.md); otherwise it is skipped.
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
const basis = (i: number) => Array.from({ length: DIMS }, (_, k) => (k === i ? 1 : 0));
const withValue = (i: number, value: number) => {
  const v = basis(0);
  v[i] = value;
  return v;
};

function model(contents: string[]): IAIProvider {
  return {
    id: "s7-model",
    name: "S7 model",
    defaultModel: "s7",
    async complete() {
      return {
        message: {
          role: "assistant",
          content: JSON.stringify({ candidates: contents.map((content) => ({ type: "FACT", content, importance: 0.8, confidence: 1 })) }),
        },
        finishReason: "stop",
        model: "s7",
      };
    },
    async listModels() {
      return ["s7"];
    },
    async isAvailable() {
      return true;
    },
  };
}

function embeddings(dimensions: number, produce: (inputs: string[]) => number[][]): IEmbeddingProvider {
  return {
    id: "s7-embeddings",
    name: "S7 embeddings",
    dimensions,
    async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
      const inputs = Array.isArray(request.input) ? request.input : [request.input];
      return { embeddings: produce(inputs), model: "s7" };
    },
    async isAvailable() {
      return true;
    },
  };
}

async function newUser(tag: string): Promise<string> {
  const user = await prisma!.user.create({
    data: { email: `s7-fp-${tag}-${STAMP}-${userIds.length}@jarvis-test.local`, name: `S7 ${tag}`, password: "not-a-real-password-hash", role: "VIEWER" },
  });
  userIds.push(user.id);
  return user.id;
}

async function run(tag: string, contents: string[], provider: IEmbeddingProvider) {
  const userId = await newUser(tag);
  const service = new MemoryExtractionService({
    aiProvider: model(contents),
    store: new db!.PrismaMemoryRepository(prisma!),
    embeddingProvider: provider,
    maxRetries: 0,
  });
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  let result;
  try {
    result = await service.extract({ userId, messages: [{ role: "user", content: "Remember these S7 facts." }], expiryDays: 90 });
  } finally {
    spy.mockRestore();
  }
  const events = lines.filter((l) => l.includes('"memory_embedding_failed"')).map((l) => JSON.parse(l) as Record<string, unknown>);
  const rows = await prisma!.$queryRawUnsafe<Array<{ content: string; hasVector: boolean; hasMetadata: boolean; metadataEqualsVector: boolean | null }>>(
    `SELECT "content",
            ("embedding" IS NOT NULL) AS "hasVector",
            coalesce(jsonb_typeof("metadata"->'embedding') = 'array', false) AS "hasMetadata",
            CASE WHEN "embedding" IS NOT NULL AND jsonb_typeof("metadata"->'embedding') = 'array'
                 THEN "embedding" = ("metadata"->'embedding')::text::vector END AS "metadataEqualsVector"
       FROM "Memory" WHERE "userId" = $1 ORDER BY "content"`,
    userId
  );
  return { result, events, rows, userId };
}

afterAll(async () => {
  if (dbUp && userIds.length > 0) await prisma!.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma?.$disconnect();
});

describe.skipIf(!dbUp)("S7 embedding failure policy — real repository (PostgreSQL)", () => {
  it("1. provider failure leaves no Memory row", async () => {
    const { rows, events } = await run("provider", ["S7 pg provider fact"], embeddings(DIMS, () => {
      throw new Error("ECONNRESET");
    }));
    expect(rows).toHaveLength(0);
    expect(events).toHaveLength(1);
  });

  it("2. invalid dimension leaves no Memory row", async () => {
    const { rows, events } = await run("dims", ["S7 pg dims fact"], embeddings(DIMS, (i) => i.map(() => [0.1, 0.2, 0.3])));
    expect(rows).toHaveLength(0);
    expect(events).toHaveLength(1);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("3. %s leaves no Memory row", async (label, bad) => {
    const { rows, events } = await run(`nonfinite-${label}`, ["S7 pg non-finite fact"], embeddings(DIMS, (i) => i.map(() => withValue(3, bad))));
    expect(rows).toHaveLength(0);
    expect(events).toHaveLength(1);
  });

  it("4. an empty vector leaves no Memory row", async () => {
    const { rows, events } = await run("empty", ["S7 pg empty fact"], embeddings(DIMS, (i) => i.map(() => [])));
    expect(rows).toHaveLength(0);
    expect(events).toHaveLength(1);
  });

  it("5. a vector PostgreSQL rejects rolls back fully: no partial row, event emitted", async () => {
    // Finite in JavaScript, so it passes every application check; pgvector
    // rejects it as out of range for its 32-bit floats, inside the transaction.
    const { result, rows, events } = await run("db-reject", ["S7 pg rejected fact"], embeddings(DIMS, (i) => i.map(() => withValue(3, 1e39))));
    expect(result.meta.memoriesCreated).toBe(0);
    expect(rows).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: "persist", reason: "storage_rejected" });
  });

  it("5b. a consistent but non-1536 vector is refused by the repository before any write", async () => {
    const { rows, events } = await run("wrong-column-size", ["S7 pg 3072 fact"], embeddings(3072, (i) => i.map(() => Array.from({ length: 3072 }, (_, k) => (k === 0 ? 1 : 0)))));
    expect(rows).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: "persist", reason: "storage_rejected" });
  });

  it("6. a successful extraction stores vector and metadata embedding together", async () => {
    const { rows, events } = await run("ok", ["S7 pg good fact"], embeddings(DIMS, (i) => i.map(() => basis(9))));
    expect(events).toHaveLength(0);
    expect(rows).toEqual([{ content: "S7 pg good fact", hasVector: true, hasMetadata: true, metadataEqualsVector: true }]);
  });

  it("7. mixed candidates: only valid, storable ones persist, each with its own vector", async () => {
    const vectors = new Map<string, number[]>([
      ["S7 pg mixed a", basis(1)],
      ["S7 pg mixed b", withValue(4, Number.NaN)],
      ["S7 pg mixed c", withValue(4, 1e39)],
      ["S7 pg mixed d", basis(2)],
    ]);
    const { rows, events, userId } = await run("mixed", [...vectors.keys()], embeddings(DIMS, (i) => i.map((t) => vectors.get(t)!)));

    expect(rows.map((r) => r.content)).toEqual(["S7 pg mixed a", "S7 pg mixed d"]);
    expect(rows.every((r) => r.hasVector && r.hasMetadata && r.metadataEqualsVector)).toBe(true);
    expect(events.map((e) => e.reason)).toEqual(["invalid_vector", "storage_rejected"]);

    const own = await prisma!.$queryRawUnsafe<Array<{ content: string; matches: boolean }>>(
      `SELECT "content", ("embedding" = CASE WHEN "content" = 'S7 pg mixed a' THEN $2::vector ELSE $3::vector END) AS "matches"
         FROM "Memory" WHERE "userId" = $1`,
      userId,
      `[${basis(1).join(",")}]`,
      `[${basis(2).join(",")}]`
    );
    expect(own.every((r) => r.matches)).toBe(true);
  });
});
