// ---------------------------------------------------------------------------
// S7 Step 8 — controlled Memory vector backfill.
//
// Memories written before the S7 retrieval repair carry their embedding only in
// `metadata.embedding`; the vector column is NULL, so the repaired vector
// recall cannot see them. This module moves those embeddings into the vector
// column — and nothing else — under strict rules. It is a one-purpose tool,
// not a migration framework. It never runs by itself: an operator drives it
// through apps/api/scripts/s7-memory-backfill (dry run by default).
//
// CATEGORIES (every row falls in exactly one):
//   already_vectorized  vector present                       -> untouched
//   no_embedding        no vector, no metadata embedding     -> untouched
//   invalid             metadata embedding not 1536 finite   -> untouched
//   expired             valid metadata embedding, expired    -> untouched
//   reembed             valid, active, but its stored embedding cannot be its
//                       own (see SUSPICION)                  -> re-embedded
//   cast                valid, active, not suspicious        -> cast
//
// SUSPICION. Before S7, extraction could attach one candidate's embedding to
// another (the alignment defect fixed in Step 5). A row is suspicious when it
// is a metadata-only row whose stored embedding is at least
// SUSPICIOUS_SIMILARITY similar to an EARLIER, different memory of the same
// user, created in a different extraction (more than
// SUSPICIOUS_MIN_GAP_SECONDS earlier), with neither row ever merged. Extraction
// would have skipped or merged a candidate that similar to an existing memory,
// so such a stored embedding cannot be the one computed for the row's text.
// Its metadata embedding is therefore NOT cast; its current content is
// re-embedded instead.
//
// SAFETY. Every write runs in a transaction that re-checks eligibility, writes
// only rows whose vector is still NULL, verifies the result, and throws —
// rolling back — if verification fails. Content, type, importance, expiry and
// timestamps are never changed; a cast does not change metadata at all. Every
// change can be reverted for exactly the rows it touched.
// ---------------------------------------------------------------------------

import type { Prisma, PrismaClient } from "@prisma/client";
import type { IEmbeddingProvider } from "@jarvis/core";

export const BACKFILL_EMBEDDING_DIMENSIONS = 1536;
export const SUSPICIOUS_SIMILARITY = 0.95;
export const SUSPICIOUS_MIN_GAP_SECONDS = 2;

/** pgvector stores 32-bit floats; anything larger is refused by PostgreSQL. */
const FLOAT4_MAX = 3.4028234663852886e38;

export interface MemoryBackfillScope {
  /** Restrict to these users (targeted runs and tests). Absent: every row. */
  userIds?: string[];
}

export interface MemoryBackfillPlan {
  totalRows: number;
  castCandidateIds: string[];
  reembedCandidateIds: string[];
  noEmbeddingIds: string[];
  alreadyVectorized: number;
  invalidMetadataEmbedding: number;
  expiredMetadataOnly: number;
}

export interface MemoryVectorCastResult {
  requested: number;
  castIds: string[];
  /** Requested rows that no longer qualified (e.g. already have a vector). */
  skippedIds: string[];
}

export interface MemoryVectorReembedResult {
  id: string;
  status: "reembedded" | "skipped";
  /** The metadata embedding before re-embedding — needed to roll back. */
  previousMetadataEmbedding?: number[] | null;
  /** md5 of the vector written, so rollback only reverts an unchanged row. */
  appliedVectorHash?: string;
}

// SQL fragment: true when `m.metadata->'embedding'` is 1536 numbers pgvector
// can hold. CASE guarantees nothing is cast before its type is known.
const VALID_METADATA_EMBEDDING = `(
  jsonb_typeof(m."metadata"->'embedding') = 'array'
  AND jsonb_array_length(m."metadata"->'embedding') = ${BACKFILL_EMBEDDING_DIMENSIONS}
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(m."metadata"->'embedding') AS e(v)
    WHERE CASE WHEN jsonb_typeof(e.v) <> 'number' THEN true
               ELSE abs((e.v)::text::float8) > ${FLOAT4_MAX} END
  )
)`;

const ACTIVE = `(m."expiresAt" IS NULL OR m."expiresAt" > now())`;

/** Every column except the vector — what a cast must leave unchanged. */
const ROW_FINGERPRINT = `md5(concat_ws('|', m."id", m."userId", m."type"::text, m."content",
  coalesce(m."summary",'~'), m."importance"::text, m."confidence"::text, m."accessCount"::text,
  coalesce(m."lastAccessedAt"::text,'~'), coalesce(m."metadata"::text,'~'), coalesce(m."sourceType",'~'),
  coalesce(m."sourceConversationId",'~'), coalesce(m."sourceMessageId",'~'), m."createdAt"::text,
  m."updatedAt"::text, coalesce(m."expiresAt"::text,'~')))`;

// ---------------------------------------------------------------------------
// Plan (read only)
// ---------------------------------------------------------------------------

export async function planMemoryVectorBackfill(
  prisma: PrismaClient,
  scope: MemoryBackfillScope = {}
): Promise<MemoryBackfillPlan> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; category: string }>>(
    `WITH base AS (
       SELECT m."id", m."userId", m."content", m."createdAt",
              (m."embedding" IS NOT NULL) AS has_vector,
              coalesce(m."metadata" ? 'mergeCount', false) AS merged,
              NOT ${ACTIVE} AS expired,
              CASE WHEN jsonb_typeof(m."metadata"->'embedding') = 'array' THEN 'array'
                   WHEN jsonb_typeof(m."metadata"->'embedding') IS NULL
                     OR jsonb_typeof(m."metadata"->'embedding') = 'null' THEN 'absent'
                   ELSE 'other' END AS meta_kind,
              ${VALID_METADATA_EMBEDDING} AS meta_valid,
              m."embedding", m."metadata"
         FROM "Memory" m
        WHERE ($1::text[] IS NULL OR m."userId" = ANY($1::text[]))
     ),
     emb AS (
       SELECT b.*,
              CASE WHEN b.has_vector THEN b."embedding"
                   WHEN b.meta_valid THEN (b."metadata"->'embedding')::text::vector END AS effective
         FROM base b
     )
     SELECT e."id",
            CASE
              WHEN e.has_vector THEN 'already_vectorized'
              WHEN e.meta_kind = 'absent' THEN 'no_embedding'
              WHEN NOT e.meta_valid THEN 'invalid'
              WHEN e.expired THEN 'expired'
              WHEN EXISTS (
                SELECT 1 FROM emb o
                 WHERE o."userId" = e."userId" AND o."id" <> e."id"
                   AND o.effective IS NOT NULL
                   AND o."createdAt" < e."createdAt" - make_interval(secs => $2)
                   AND o."content" <> e."content"
                   AND NOT o.merged AND NOT e.merged
                   AND 1 - (o.effective <=> e.effective) >= $3
              ) THEN 'reembed'
              ELSE 'cast'
            END AS category
       FROM emb e
      ORDER BY e."id"`,
    scope.userIds ?? null,
    SUSPICIOUS_MIN_GAP_SECONDS,
    SUSPICIOUS_SIMILARITY
  );

  const idsOf = (category: string) => rows.filter((r) => r.category === category).map((r) => r.id);
  return {
    totalRows: rows.length,
    castCandidateIds: idsOf("cast"),
    reembedCandidateIds: idsOf("reembed"),
    noEmbeddingIds: idsOf("no_embedding"),
    alreadyVectorized: idsOf("already_vectorized").length,
    invalidMetadataEmbedding: idsOf("invalid").length,
    expiredMetadataOnly: idsOf("expired").length,
  };
}

// ---------------------------------------------------------------------------
// Cast (metadata.embedding -> vector)
// ---------------------------------------------------------------------------

/**
 * Casts one batch in one transaction. Rows are re-checked and locked first;
 * only rows that still have no vector, a valid metadata embedding and no
 * expiry are written. The transaction is rolled back unless every written row
 * then holds exactly its own metadata embedding and is otherwise unchanged.
 */
export async function applyMemoryVectorCastBatch(
  prisma: PrismaClient,
  ids: string[]
): Promise<MemoryVectorCastResult> {
  if (ids.length === 0) return { requested: 0, castIds: [], skippedIds: [] };

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const eligible = await tx.$queryRawUnsafe<Array<{ id: string; fp: string }>>(
      `SELECT m."id", ${ROW_FINGERPRINT} AS fp
         FROM "Memory" m
        WHERE m."id" = ANY($1::text[])
          AND m."embedding" IS NULL
          AND ${VALID_METADATA_EMBEDDING}
          AND ${ACTIVE}
        FOR UPDATE`,
      ids
    );
    const castIds = eligible.map((r) => r.id);
    const skippedIds = ids.filter((id) => !castIds.includes(id));
    if (castIds.length === 0) return { requested: ids.length, castIds, skippedIds };

    const updated = await tx.$executeRawUnsafe(
      `UPDATE "Memory" SET "embedding" = ("metadata"->'embedding')::text::vector
        WHERE "id" = ANY($1::text[]) AND "embedding" IS NULL`,
      castIds
    );
    if (Number(updated) !== castIds.length) {
      throw new Error(`Backfill verification failed: expected ${castIds.length} rows updated, got ${updated}`);
    }

    const after = await tx.$queryRawUnsafe<Array<{ id: string; fp: string; ok: boolean }>>(
      `SELECT m."id", ${ROW_FINGERPRINT} AS fp,
              (vector_dims(m."embedding") = ${BACKFILL_EMBEDDING_DIMENSIONS}
               AND m."embedding" = (m."metadata"->'embedding')::text::vector) AS ok
         FROM "Memory" m WHERE m."id" = ANY($1::text[])`,
      castIds
    );
    const before = new Map(eligible.map((r) => [r.id, r.fp]));
    const bad = after.filter((r) => !r.ok || before.get(r.id) !== r.fp);
    if (after.length !== castIds.length || bad.length > 0) {
      throw new Error(`Backfill verification failed for ${bad.length || castIds.length - after.length} row(s); batch rolled back`);
    }

    return { requested: ids.length, castIds, skippedIds };
  });
}

/**
 * Reverts a cast: clears the vector of exactly these rows, and only where it
 * still equals the metadata embedding it was cast from.
 */
export async function rollbackMemoryVectorCastBatch(prisma: PrismaClient, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const reverted = await prisma.$executeRawUnsafe(
    `UPDATE "Memory" SET "embedding" = NULL
      WHERE "id" = ANY($1::text[])
        AND "embedding" IS NOT NULL
        AND jsonb_typeof("metadata"->'embedding') = 'array'
        AND "embedding" = ("metadata"->'embedding')::text::vector`,
    ids
  );
  return Number(reverted);
}

// ---------------------------------------------------------------------------
// Re-embed (suspicious rows)
// ---------------------------------------------------------------------------

function assertStorableVector(vector: unknown): asserts vector is number[] {
  const ok =
    Array.isArray(vector) &&
    vector.length === BACKFILL_EMBEDDING_DIMENSIONS &&
    vector.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= FLOAT4_MAX);
  if (!ok) throw new Error("Re-embedding returned a vector that is not 1536 finite numbers");
}

/**
 * Re-embeds each row's CURRENT content and stores the result in the vector
 * column and `metadata.embedding` together, one row per transaction. The row's
 * text is sent to `provider` and nowhere else; it is never logged or returned.
 * Content, other metadata keys and every other column are left unchanged.
 */
export async function reembedMemoryVectors(
  prisma: PrismaClient,
  provider: IEmbeddingProvider,
  ids: string[],
  options: { model: string }
): Promise<MemoryVectorReembedResult[]> {
  const results: MemoryVectorReembedResult[] = [];

  for (const id of ids) {
    const rows = await prisma.$queryRawUnsafe<Array<{ content: string; previous: unknown }>>(
      `SELECT m."content", m."metadata"->'embedding' AS previous
         FROM "Memory" m WHERE m."id" = $1 AND m."embedding" IS NULL AND ${ACTIVE}`,
      id
    );
    const row = rows[0];
    if (!row) {
      results.push({ id, status: "skipped" });
      continue;
    }

    const response = await provider.embed({ input: [row.content], model: options.model });
    if (!Array.isArray(response?.embeddings) || response.embeddings.length !== 1) {
      throw new Error("Re-embedding returned an unexpected number of vectors");
    }
    const vector = response.embeddings[0];
    assertStorableVector(vector);
    const vectorSql = `[${vector.join(",")}]`;

    const appliedVectorHash = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const before = await tx.$queryRawUnsafe<Array<{ content_fp: string; other_metadata: string }>>(
        `SELECT md5(m."content") AS content_fp, coalesce((m."metadata" - 'embedding')::text, '~') AS other_metadata
           FROM "Memory" m WHERE m."id" = $1 AND m."embedding" IS NULL FOR UPDATE`,
        id
      );
      if (before.length !== 1) throw new Error("Row no longer qualifies for re-embedding");

      const updated = await tx.$executeRawUnsafe(
        `UPDATE "Memory"
            SET "embedding" = $1::vector,
                "metadata" = jsonb_set(coalesce("metadata", '{}'::jsonb), '{embedding}', $2::jsonb)
          WHERE "id" = $3 AND "embedding" IS NULL`,
        vectorSql,
        JSON.stringify(vector),
        id
      );
      if (Number(updated) !== 1) throw new Error("Re-embedding verification failed: row not updated");

      const after = await tx.$queryRawUnsafe<Array<{ ok: boolean; hash: string }>>(
        `SELECT (vector_dims(m."embedding") = ${BACKFILL_EMBEDDING_DIMENSIONS}
                 AND m."embedding" = $2::vector
                 AND m."embedding" = (m."metadata"->'embedding')::text::vector
                 AND md5(m."content") = $3
                 AND coalesce((m."metadata" - 'embedding')::text, '~') = $4) AS ok,
                md5(m."embedding"::text) AS hash
           FROM "Memory" m WHERE m."id" = $1`,
        id,
        vectorSql,
        before[0]!.content_fp,
        before[0]!.other_metadata
      );
      if (!after[0]?.ok) throw new Error("Re-embedding verification failed; row rolled back");
      return after[0].hash;
    });

    results.push({
      id,
      status: "reembedded",
      previousMetadataEmbedding: Array.isArray(row.previous) ? (row.previous as number[]) : null,
      appliedVectorHash,
    });
  }

  return results;
}

/**
 * Reverts re-embedding: clears the vector and restores the previous metadata
 * embedding, only for rows whose vector is still the one the backfill wrote.
 */
export async function rollbackMemoryVectorReembed(
  prisma: PrismaClient,
  entries: MemoryVectorReembedResult[]
): Promise<number> {
  let restored = 0;
  for (const entry of entries) {
    if (entry.status !== "reembedded" || !entry.appliedVectorHash) continue;
    const previous = entry.previousMetadataEmbedding ?? null;
    const updated = await prisma.$executeRawUnsafe(
      `UPDATE "Memory"
          SET "embedding" = NULL,
              "metadata" = CASE WHEN $2::jsonb IS NULL THEN "metadata" - 'embedding'
                                ELSE jsonb_set("metadata", '{embedding}', $2::jsonb) END
        WHERE "id" = $1 AND "embedding" IS NOT NULL AND md5("embedding"::text) = $3`,
      entry.id,
      previous === null ? null : JSON.stringify(previous),
      entry.appliedVectorHash
    );
    restored += Number(updated);
  }
  return restored;
}
