import type { DocumentChunkingResult, IKnowledgeRepository } from "@jarvis/core";

/**
 * Bridge from a chunking result to the Sprint 3.1 knowledge repository.
 *
 * As with {@link toKnowledgeDocumentInput}, the return type is pinned to the
 * repository's own parameter type, so this mapper cannot drift from
 * `IKnowledgeRepository.createChunks` without a compile error. Nothing here
 * extends the Sprint 3.1 contract — chunking is a producer of that existing
 * shape.
 *
 * Persistence stays the caller's decision: the mapper only builds the payload,
 * so chunking remains usable without a database.
 */
export type KnowledgeChunkInput = Parameters<
  IKnowledgeRepository["createChunks"]
>[1][number];

/**
 * `chunkIndex` carries the chunk's own `index`, so repository ordering matches
 * document order exactly.
 *
 * The deterministic `id` and the offsets travel inside `metadata` rather than
 * as columns: the Sprint 3.1 schema generates its own row id, and offsets are
 * only meaningful alongside the exact text they index — which `contentHash`
 * and `chunkingVersion` let a later stage verify before trusting them.
 */
export function toKnowledgeChunkInputs(
  result: DocumentChunkingResult
): KnowledgeChunkInput[] {
  return result.chunks.map((chunk) => ({
    content: chunk.content,
    chunkIndex: chunk.index,
    metadata: {
      chunkId: chunk.id,
      charCount: chunk.charCount,
      wordCount: chunk.wordCount,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      overlapWithPrevious: chunk.overlapWithPrevious,
      boundary: chunk.boundary,
      chunkSize: result.chunkSize,
      chunkOverlap: result.chunkOverlap,
      ...chunk.metadata,
    },
  }));
}
