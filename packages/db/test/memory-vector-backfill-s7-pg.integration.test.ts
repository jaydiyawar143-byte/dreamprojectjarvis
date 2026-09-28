// S7 Step 8 — controlled memory vector backfill, against REAL PostgreSQL +
// pgvector with SYNTHETIC rows only (never deployment data).
//
// The backfill must:
//   - cast only clean, active, metadata-only rows (metadata.embedding -> vector)
//   - re-embed, not cast, a row whose stored embedding cannot be its own
//   - leave no-embedding, already-vectorized, malformed and expired rows alone
//   - never change content or metadata of a cast row
//   - be idempotent, verifiable, and reversible for exactly what it changed
// and repaired rows must then be served by the repaired vector recall.
//
// SAFETY. DATABASE_URL is read BEFORE the Prisma client is imported (the
// client loads packages/db/.env on import), so this runs only against an
// explicitly supplied, separate test database. The re-embedding provider is a
// deterministic stand-in: no network.
import { describe, it, expect, afterAll } from "vitest";
import type { EmbeddingRequest, EmbeddingResponse, IEmbeddingProvider } from "@jarvis/core";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;

const { PrismaClient } = await import("@prisma/client");
const { PrismaMemoryRepository } = await import("../src/repositories/memory-repository.js");
const backfill = await import("../src/maintenance/memory-vector-backfill.js");

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

const DIMS = 1536;
const STAMP = Date.now();
const userIds: string[] = [];
const toSql = (v: number[]) => `[${v.join(",")}]`;

// ---- deterministic, realistic vectors --------------------------------------
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const normalise = (v: number[]) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};
const realistic = (seed: number) => {
  const r = mulberry32(seed);
  return normalise(Array.from({ length: DIMS }, () => r() - 0.5));
};
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
function atCos(base: number[], cos: number, seed: number): number[] {
  const o = realistic(seed);
  const d = dot(o, base);
  const orth = normalise(o.map((x, i) => x - d * base[i]!));
  return normalise(base.map((x, i) => cos * x + Math.sqrt(1 - cos * cos) * orth[i]!));
}

const CLEAN = realistic(101);
const EARLIER = realistic(102);
const SUSPICIOUS_STORED = atCos(EARLIER, 0.97, 103); // 0.97 to an earlier, different memory
const SUSPICIOUS_FRESH = realistic(104); // what re-embedding its real content returns
const VECTORIZED = realistic(105);
const EXPIRED = realistic(106);
const OTHER_USER = atCos(CLEAN, 0.99, 107);

const CONTENT = {
  clean: "S7 backfill clean memory",
  earlier: "S7 backfill earlier memory",
  suspicious: "S7 backfill suspicious memory with unrelated wording",
  none: "S7 backfill memory without any embedding",
  vectorized: "S7 backfill already vectorized memory",
  malformed: "S7 backfill malformed metadata memory",
  expired: "S7 backfill expired memory",
  other: "S7 backfill other user memory",
};

/** Re-embedding stand-in; records every text it was asked to embed. */
class RecordingEmbeddings implements IEmbeddingProvider {
  readonly id = "s7-backfill-embeddings";
  readonly name = "S7 backfill embeddings";
  readonly dimensions = DIMS;
  readonly inputs: string[] = [];
  readonly models: Array<string | undefined> = [];
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    this.inputs.push(...inputs);
    this.models.push(request.model);
    return { embeddings: inputs.map((t) => (t === CONTENT.suspicious ? SUSPICIOUS_FRESH : realistic(999))), model: request.model ?? "s7" };
  }
  async isAvailable() {
    return true;
  }
}

const ids: Record<string, string> = {};

async function newUser(tag: string) {
  const user = await prisma.user.create({
    data: { email: `s7-bf-${tag}-${STAMP}@jarvis-test.local`, name: `S7 ${tag}`, password: "not-a-real-password-hash", role: "VIEWER" },
  });
  userIds.push(user.id);
  return user.id;
}

async function insert(key: string, userId: string, opts: { metadata: unknown; vector?: number[]; createdAt: Date; expiresAt: Date }) {
  const row = await prisma.memory.create({
    data: {
      userId,
      type: "FACT",
      content: CONTENT[key as keyof typeof CONTENT],
      importance: 0.8,
      confidence: 1,
      sourceType: "conversation",
      ...(opts.metadata === null ? {} : { metadata: opts.metadata as object }),
      createdAt: opts.createdAt,
      expiresAt: opts.expiresAt,
    },
  });
  if (opts.vector) {
    await prisma.$executeRawUnsafe('UPDATE "Memory" SET "embedding" = $1::vector WHERE "id" = $2', toSql(opts.vector), row.id);
  }
  ids[key] = row.id;
}

/** Whole-row fingerprints, vector included — to prove untouched rows stay byte-identical. */
async function fingerprints(keys: string[]): Promise<Record<string, string>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; fp: string }>>(
    `SELECT "id", md5(concat_ws('|', "content", "type"::text, "importance"::text, "confidence"::text,
            coalesce("metadata"::text,'~'), coalesce("expiresAt"::text,'~'), "updatedAt"::text,
            coalesce("embedding"::text,'~'))) AS fp
       FROM "Memory" WHERE "id" = ANY($1::text[])`,
    keys.map((k) => ids[k]!)
  );
  const byId = new Map(rows.map((r) => [r.id, r.fp]));
  return Object.fromEntries(keys.map((k) => [k, byId.get(ids[k]!)!]));
}

async function vectorFacts(key: string, compareWith: number[]) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT ("embedding" IS NOT NULL) AS "hasVector",
            CASE WHEN "embedding" IS NULL THEN NULL ELSE vector_dims("embedding") END AS "dims",
            CASE WHEN "embedding" IS NULL THEN NULL ELSE "embedding" = ("metadata"->'embedding')::text::vector END AS "vectorEqualsMetadata",
            CASE WHEN "embedding" IS NULL THEN NULL ELSE 1 - ("embedding" <=> $2::vector) END AS "similarityToExpected",
            "content"
       FROM "Memory" WHERE "id" = $1`,
    ids[key]!,
    toSql(compareWith)
  );
  return rows[0]!;
}

let U1 = "";
let U2 = "";
let castApplied: Array<{ id: string; appliedVectorHash: string }> = [];
const scope = () => ({ userIds: [U1, U2] });

afterAll(async () => {
  if (dbUp && userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe.skipIf(!dbUp)("S7 controlled memory vector backfill (PostgreSQL, synthetic data)", () => {
  const now = Date.now();
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000);
  const in90 = new Date(now + 90 * 86400000);

  it("classifies every category correctly in a dry-run plan", async () => {
    U1 = await newUser("u1");
    U2 = await newUser("u2");
    await insert("clean", U1, { metadata: { embedding: CLEAN }, createdAt: at(600), expiresAt: in90 });
    await insert("earlier", U1, { metadata: { embedding: EARLIER }, createdAt: at(500), expiresAt: in90 });
    await insert("suspicious", U1, { metadata: { embedding: SUSPICIOUS_STORED }, createdAt: at(400), expiresAt: in90 });
    await insert("none", U1, { metadata: null, createdAt: at(300), expiresAt: in90 });
    await insert("vectorized", U1, { metadata: { embedding: VECTORIZED }, vector: VECTORIZED, createdAt: at(250), expiresAt: in90 });
    await insert("malformed", U1, { metadata: { embedding: [0.1, "not-a-number", 0.3] }, createdAt: at(200), expiresAt: in90 });
    await insert("expired", U1, { metadata: { embedding: EXPIRED }, createdAt: at(150), expiresAt: at(60) });
    await insert("other", U2, { metadata: { embedding: OTHER_USER }, createdAt: at(100), expiresAt: in90 });

    const plan = await backfill.planMemoryVectorBackfill(prisma, scope());

    expect([...plan.castCandidateIds].sort()).toEqual([ids.clean, ids.earlier, ids.other].sort());
    expect(plan.reembedCandidateIds).toEqual([ids.suspicious]);
    expect(plan.noEmbeddingIds).toEqual([ids.none]);
    expect(plan.alreadyVectorized).toBe(1);
    expect(plan.invalidMetadataEmbedding).toBe(1);
    expect(plan.expiredMetadataOnly).toBe(1);
    expect(plan.vectorMetadataMismatch).toBe(0);
    expect(plan.totalRows).toBe(8);
  });

  it("casts clean rows, re-embeds the suspicious row, and leaves everything else untouched", async () => {
    const untouched = ["none", "vectorized", "malformed", "expired"];
    const before = await fingerprints(untouched);
    const castBefore = await prisma.$queryRawUnsafe<Array<{ id: string; fp: string }>>(
      `SELECT "id", md5(concat_ws('|', "content", coalesce("metadata"::text,'~'), "updatedAt"::text, coalesce("expiresAt"::text,'~'))) AS fp
         FROM "Memory" WHERE "id" = ANY($1::text[])`,
      [ids.clean, ids.earlier, ids.other]
    );

    const plan = await backfill.planMemoryVectorBackfill(prisma, scope());
    const cast = await backfill.applyMemoryVectorCastBatch(prisma, plan.castCandidateIds);
    castApplied = cast.applied;
    const provider = new RecordingEmbeddings();
    const reembedded = await backfill.reembedMemoryVectors(prisma, provider, plan.reembedCandidateIds, { model: "text-embedding-3-small" });

    expect([...cast.castIds].sort()).toEqual([ids.clean, ids.earlier, ids.other].sort());
    expect(cast.skippedIds).toEqual([]);
    expect(reembedded).toHaveLength(1);
    expect(reembedded[0]).toMatchObject({ id: ids.suspicious, status: "reembedded" });

    // Only the suspicious row's text went to the provider, with the configured model.
    expect(provider.inputs).toEqual([CONTENT.suspicious]);
    expect(provider.models).toEqual(["text-embedding-3-small"]);

    // Clean rows: vector == their own metadata embedding; content and metadata unchanged.
    for (const [key, vector] of [["clean", CLEAN], ["earlier", EARLIER], ["other", OTHER_USER]] as const) {
      const facts = await vectorFacts(key, vector);
      expect(facts.hasVector).toBe(true);
      expect(Number(facts.dims)).toBe(DIMS);
      expect(facts.vectorEqualsMetadata).toBe(true);
      expect(Number(facts.similarityToExpected)).toBeGreaterThan(0.999999);
    }
    const castAfter = await prisma.$queryRawUnsafe<Array<{ id: string; fp: string }>>(
      `SELECT "id", md5(concat_ws('|', "content", coalesce("metadata"::text,'~'), "updatedAt"::text, coalesce("expiresAt"::text,'~'))) AS fp
         FROM "Memory" WHERE "id" = ANY($1::text[])`,
      [ids.clean, ids.earlier, ids.other]
    );
    expect(new Map(castAfter.map((r) => [r.id, r.fp]))).toEqual(new Map(castBefore.map((r) => [r.id, r.fp])));

    // Suspicious row: the NEW embedding, in both vector and metadata; content unchanged.
    const suspicious = await vectorFacts("suspicious", SUSPICIOUS_FRESH);
    expect(Number(suspicious.similarityToExpected)).toBeGreaterThan(0.999999);
    expect(suspicious.vectorEqualsMetadata).toBe(true);
    expect(suspicious.content).toBe(CONTENT.suspicious);

    // Untouched rows are byte-identical, vector included.
    expect(await fingerprints(untouched)).toEqual(before);
  });

  it("a second run changes nothing", async () => {
    const plan = await backfill.planMemoryVectorBackfill(prisma, scope());
    expect(plan.castCandidateIds).toEqual([]);
    expect(plan.reembedCandidateIds).toEqual([]);

    const again = await backfill.applyMemoryVectorCastBatch(prisma, [ids.clean!, ids.earlier!]);
    expect(again.castIds).toEqual([]);
    expect([...again.skippedIds].sort()).toEqual([ids.clean, ids.earlier].sort());
    const reembedAgain = await backfill.reembedMemoryVectors(prisma, new RecordingEmbeddings(), [ids.suspicious!], { model: "text-embedding-3-small" });
    expect(reembedAgain[0]).toMatchObject({ status: "skipped" });
  });

  it("repaired rows are served by the repaired vector recall", async () => {
    const repo = new PrismaMemoryRepository(prisma);
    const query = atCos(CLEAN, 0.9, 201);
    const results = await repo.recall({ userId: U1, query: "", embedding: query, limit: 5, minSimilarity: 0.3 });

    const got = results.map((r) => r.memory.id);
    expect(got[0]).toBe(ids.clean); // most similar first
    expect(results[0]!.semanticScore).toBeCloseTo(0.9, 5);
    expect(got).not.toContain(ids.expired); // expiry
    expect(got).not.toContain(ids.other); // isolation: U2's near-identical memory
    expect(results.every((r) => r.semanticScore >= 0.3)).toBe(true); // similarity floor
    expect(results.every((r) => r.memory.userId === U1)).toBe(true);
    const again = await repo.recall({ userId: U1, query: "", embedding: query, limit: 5, minSimilarity: 0.3 });
    expect(again.map((r) => r.memory.id)).toEqual(got); // deterministic
  });

  it("rollback reverts exactly what the backfill changed, and nothing else", async () => {
    const untouched = ["none", "vectorized", "malformed", "expired"];
    const before = await fingerprints(untouched);

    const reverted = await backfill.rollbackMemoryVectorCastBatch(prisma, castApplied);
    expect(reverted).toEqual({ reverted: 3, conflicted: 0 });

    const plan = await backfill.planMemoryVectorBackfill(prisma, scope());
    expect([...plan.castCandidateIds].sort()).toEqual([ids.clean, ids.earlier, ids.other].sort());

    for (const key of ["clean", "earlier", "other"]) {
      const facts = await vectorFacts(key, CLEAN);
      expect(facts.hasVector).toBe(false);
    }
    expect(await fingerprints(untouched)).toEqual(before);
  });

  it("re-embed rollback restores the previous metadata embedding and clears the vector", async () => {
    // Fresh pair so this test does not depend on the rollback above.
    const earlier2 = realistic(301);
    await insert("clean", U1, { metadata: { embedding: earlier2 }, createdAt: at(90), expiresAt: in90 });
    const storedBad = atCos(earlier2, 0.97, 302);
    CONTENT.suspicious = "S7 backfill second suspicious memory";
    await insert("suspicious", U1, { metadata: { embedding: storedBad, note: "kept" }, createdAt: at(30), expiresAt: in90 });

    const [result] = await backfill.reembedMemoryVectors(prisma, new RecordingEmbeddings(), [ids.suspicious!], { model: "text-embedding-3-small" });
    expect(result!.status).toBe("reembedded");

    const restored = await backfill.rollbackMemoryVectorReembed(prisma, [result!]);
    expect(restored).toEqual({ reverted: 1, conflicted: 0 });
    const row = await prisma.$queryRawUnsafe<Array<{ hasVector: boolean; metadataEqualsOld: boolean; note: string }>>(
      `SELECT ("embedding" IS NOT NULL) AS "hasVector",
              ("metadata"->'embedding')::text::vector = $2::vector AS "metadataEqualsOld",
              "metadata"->>'note' AS "note"
         FROM "Memory" WHERE "id" = $1`,
      ids.suspicious!,
      toSql(storedBad)
    );
    expect(row[0]).toEqual({ hasVector: false, metadataEqualsOld: true, note: "kept" });
  });
});

// ---------------------------------------------------------------------------
// S7 Step 9B — exact cast rollback (F2), the re-embed content race (F3), and
// the vector/metadata disagreement count that exposes a pre-S7 writer (F1).
// ---------------------------------------------------------------------------

/** Every column except the vector: what a rollback or a refused write must not touch. */
async function rowState(id: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ fp: string; hasVector: boolean; vectorHash: string | null; content: string }>>(
    `SELECT md5(concat_ws('|', "content", "type"::text, "importance"::text, coalesce("metadata"::text,'~'),
            coalesce("expiresAt"::text,'~'), "updatedAt"::text)) AS fp,
            ("embedding" IS NOT NULL) AS "hasVector",
            CASE WHEN "embedding" IS NULL THEN NULL ELSE md5("embedding"::text) END AS "vectorHash",
            "content"
       FROM "Memory" WHERE "id" = $1`,
    id
  );
  return rows[0]!;
}

async function metadataEmbeddingEquals(id: string, vector: number[]) {
  const rows = await prisma.$queryRawUnsafe<Array<{ eq: boolean }>>(
    `SELECT ("metadata"->'embedding')::text::vector = $2::vector AS eq FROM "Memory" WHERE "id" = $1`,
    id,
    toSql(vector)
  );
  return rows[0]!.eq;
}

/** An S7-code merge: new content, and a new embedding in BOTH places. */
async function s7Merge(id: string, content: string, vector: number[]) {
  await prisma.$executeRawUnsafe(
    `UPDATE "Memory" SET "content" = $2, "embedding" = $3::vector,
            "metadata" = jsonb_set("metadata", '{embedding}', $4::jsonb)
      WHERE "id" = $1`,
    id,
    content,
    toSql(vector),
    JSON.stringify(vector)
  );
}

/** Embeds like the real provider, but lets a test run a concurrent write mid-call. */
class RacingEmbeddings implements IEmbeddingProvider {
  readonly id = "s7-racing-embeddings";
  readonly name = "S7 racing embeddings";
  readonly dimensions = DIMS;
  constructor(
    private readonly result: number[],
    private readonly duringEmbed?: () => Promise<void>
  ) {}
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (this.duringEmbed) await this.duringEmbed();
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return { embeddings: inputs.map(() => this.result), model: request.model ?? "s7" };
  }
  async isAvailable() {
    return true;
  }
}

describe.skipIf(!dbUp)("S7 Step 9B — exact rollback and re-embed race (PostgreSQL, synthetic data)", () => {
  const in90 = new Date(Date.now() + 90 * 86400000);
  let U3 = "";
  const row: Record<string, string> = {};

  async function metadataOnly(key: string, userId: string, content: string, embedding: number[], extra: object = {}) {
    const created = await prisma.memory.create({
      data: { userId, type: "FACT", content, importance: 0.7, confidence: 1, sourceType: "conversation", metadata: { embedding, ...extra }, expiresAt: in90 },
    });
    row[key] = created.id;
    return created.id;
  }

  it("F2 — a cast records the md5 of the exact vector it wrote", async () => {
    U3 = await newUser("u3");
    await metadataOnly("keep", U3, "S7 9B cast row that stays as written", realistic(401));
    await metadataOnly("changed", U3, "S7 9B cast row that is merged later", realistic(402));

    const result = await backfill.applyMemoryVectorCastBatch(prisma, [row.keep!, row.changed!]);

    expect([...result.castIds].sort()).toEqual([row.keep, row.changed].sort());
    expect(result.applied).toHaveLength(2);
    for (const applied of result.applied) {
      const state = await rowState(applied.id);
      expect(state.hasVector).toBe(true);
      expect(applied.appliedVectorHash).toMatch(/^[0-9a-f]{32}$/);
      expect(applied.appliedVectorHash).toBe(state.vectorHash);
    }
    castApplied = result.applied;
  });

  it("F2 — rollback restores NULL where the hash still matches, leaving content and metadata alone", async () => {
    const before = await rowState(row.keep!);
    const keepEntry = castApplied.filter((a) => a.id === row.keep);

    const outcome = await backfill.rollbackMemoryVectorCastBatch(prisma, keepEntry);

    expect(outcome).toEqual({ reverted: 1, conflicted: 0 });
    const after = await rowState(row.keep!);
    expect(after.hasVector).toBe(false);
    expect(after.fp).toBe(before.fp); // content, metadata, timestamps untouched
  });

  it("F2 — a later change to the vector prevents rollback, and the later change stays untouched", async () => {
    const LATER = realistic(403);
    await s7Merge(row.changed!, "S7 9B merged content written later by S7 code", LATER);
    const before = await rowState(row.changed!);
    const changedEntry = castApplied.filter((a) => a.id === row.changed);

    const outcome = await backfill.rollbackMemoryVectorCastBatch(prisma, changedEntry);

    expect(outcome).toEqual({ reverted: 0, conflicted: 1 });
    const after = await rowState(row.changed!);
    expect(after).toEqual(before); // vector, content and metadata exactly as the later writer left them
    expect(after.hasVector).toBe(true);
    expect(after.content).toBe("S7 9B merged content written later by S7 code");
    expect(await metadataEmbeddingEquals(row.changed!, LATER)).toBe(true);
  });

  it("F3 — re-embed writes when the content is unchanged under the row lock", async () => {
    const FRESH = realistic(411);
    await metadataOnly("stable", U3, "S7 9B re-embed row whose content does not change", realistic(412));

    const [result] = await backfill.reembedMemoryVectors(prisma, new RacingEmbeddings(FRESH), [row.stable!], { model: "text-embedding-3-small" });

    expect(result).toMatchObject({ id: row.stable, status: "reembedded" });
    const state = await rowState(row.stable!);
    expect(state.hasVector).toBe(true);
    expect(state.vectorHash).toBe(result!.appliedVectorHash);
    expect(await metadataEmbeddingEquals(row.stable!, FRESH)).toBe(true);
    expect(state.content).toBe("S7 9B re-embed row whose content does not change");
  });

  it("F3 — re-embed refuses to write when the content changed while the embedding was generated", async () => {
    const STALE_RESULT = realistic(421); // the embedding of the OLD text
    const CONCURRENT = realistic(422);
    await metadataOnly("racing", U3, "S7 9B text that was read and sent for embedding", realistic(423), { note: "kept" });
    // A pre-S7 merge lands while the provider is working: new content and a
    // new metadata embedding, no vector.
    const concurrentWriter = async () => {
      await prisma.$executeRawUnsafe(
        `UPDATE "Memory" SET "content" = $2, "metadata" = jsonb_set("metadata", '{embedding}', $3::jsonb) WHERE "id" = $1`,
        row.racing!,
        "S7 9B text rewritten by a concurrent writer",
        JSON.stringify(CONCURRENT)
      );
    };
    const [result] = await backfill.reembedMemoryVectors(
      prisma,
      new RacingEmbeddings(STALE_RESULT, concurrentWriter),
      [row.racing!],
      { model: "text-embedding-3-small" }
    );

    expect(result).toEqual({ id: row.racing, status: "conflicted" });
    const state = await rowState(row.racing!);
    expect(state.hasVector).toBe(false); // no stale vector
    expect(state.content).toBe("S7 9B text rewritten by a concurrent writer"); // the writer's content stands
    expect(await metadataEmbeddingEquals(row.racing!, CONCURRENT)).toBe(true); // and its embedding
  });

  it("F3 — re-embed also refuses when only the metadata embedding changed underneath it", async () => {
    const OTHER = realistic(431);
    await metadataOnly("metaRace", U3, "S7 9B row whose metadata embedding is replaced mid-call", realistic(432));
    const [result] = await backfill.reembedMemoryVectors(
      prisma,
      new RacingEmbeddings(realistic(433), async () => {
        await prisma.$executeRawUnsafe(
          `UPDATE "Memory" SET "metadata" = jsonb_set("metadata", '{embedding}', $2::jsonb) WHERE "id" = $1`,
          row.metaRace!,
          JSON.stringify(OTHER)
        );
      }),
      [row.metaRace!],
      { model: "text-embedding-3-small" }
    );

    expect(result).toEqual({ id: row.metaRace, status: "conflicted" });
    expect((await rowState(row.metaRace!)).hasVector).toBe(false);
    expect(await metadataEmbeddingEquals(row.metaRace!, OTHER)).toBe(true);
  });

  it("F1 — the plan counts rows whose vector disagrees with their metadata embedding", async () => {
    const U4 = await newUser("u4");
    const consistent = realistic(441);
    await insert("vectorized", U4, { metadata: { embedding: consistent }, vector: consistent, createdAt: new Date(), expiresAt: in90 });
    // A pre-S7 merge after a backfill: metadata moved on, the vector did not.
    await insert("clean", U4, { metadata: { embedding: realistic(442) }, vector: realistic(443), createdAt: new Date(), expiresAt: in90 });

    const plan = await backfill.planMemoryVectorBackfill(prisma, { userIds: [U4] });

    expect(plan.alreadyVectorized).toBe(2);
    expect(plan.vectorMetadataMismatch).toBe(1);
    expect(plan.castCandidateIds).toEqual([]);
  });
});
