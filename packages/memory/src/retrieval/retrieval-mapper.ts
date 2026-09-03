import type {
  ChunkSectionRef,
  KnowledgeChunkMatch,
  RetrievedChunk,
} from "@jarvis/core";

/**
 * Lifts the provenance Sprint 3.3 wrote into chunk metadata onto the retrieval
 * result, so a caller can cite "page 4, Refund Policy" without re-parsing a
 * JSON blob.
 *
 * Every read is defensive. `KnowledgeChunk.metadata` is a `Json?` column: rows
 * predate this contract, were written by an older chunker, or were edited by
 * hand, and none of that should turn a search into an exception. A field that
 * is missing or the wrong shape is simply absent from the result, and the
 * untouched blob always travels along on `metadata` so nothing is lost.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readPageNumbers(metadata: Record<string, unknown> | null): number[] {
  const raw = metadata?.["pageNumbers"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value)
  );
}

function readSectionRef(value: unknown): ChunkSectionRef | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const title = record["title"];
  const level = record["level"];
  const order = record["order"];
  if (
    typeof title !== "string" ||
    typeof level !== "number" ||
    typeof order !== "number"
  ) {
    return undefined;
  }

  return { title, level, order };
}

function readSections(metadata: Record<string, unknown> | null): ChunkSectionRef[] {
  const raw = metadata?.["sections"];
  if (!Array.isArray(raw)) return [];
  return raw
    .map(readSectionRef)
    .filter((section): section is ChunkSectionRef => section !== undefined);
}

function readOffset(
  metadata: Record<string, unknown> | null,
  key: string
): number | undefined {
  const value = metadata?.[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

/** Converts one repository match into the retrieval result shape. */
export function toRetrievedChunk(match: KnowledgeChunkMatch): RetrievedChunk {
  const metadata = asRecord(match.metadata);

  const result: RetrievedChunk = {
    chunkId: match.id,
    documentId: match.documentId,
    documentTitle: match.documentTitle,
    documentType: match.documentType,
    source: match.source,
    chunkIndex: match.chunkIndex,
    content: match.content,
    score: match.score,
    distance: match.distance,
    pageNumbers: readPageNumbers(metadata),
    sections: readSections(metadata),
    metadata,
  };

  const deterministicChunkId = metadata?.["chunkId"];
  if (typeof deterministicChunkId === "string" && deterministicChunkId.length > 0) {
    result.deterministicChunkId = deterministicChunkId;
  }

  const primarySection = readSectionRef(metadata?.["primarySection"]);
  if (primarySection) result.primarySection = primarySection;

  const startOffset = readOffset(metadata, "startOffset");
  if (startOffset !== undefined) result.startOffset = startOffset;

  const endOffset = readOffset(metadata, "endOffset");
  if (endOffset !== undefined) result.endOffset = endOffset;

  return result;
}

/**
 * Total ordering over results: nearest first, then `(documentId, chunkIndex)`.
 *
 * The tiebreakers are what make "deterministic relevance order" true rather
 * than incidental. Two chunks with identical text embed to identical vectors
 * and therefore score identically, and neither Postgres nor an in-memory store
 * promises an order among equal keys — so the comparator, not the source, is
 * what guarantees the same query returns the same order every time.
 */
export function compareRetrievedChunks(a: RetrievedChunk, b: RetrievedChunk): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.documentId !== b.documentId) return a.documentId < b.documentId ? -1 : 1;
  return a.chunkIndex - b.chunkIndex;
}
