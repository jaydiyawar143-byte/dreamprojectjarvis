export { MemoryEngine } from "./memory-engine.js";
export type { MemoryEngineConfig } from "./memory-engine.js";
export { MemoryExtractionService } from "./memory-extraction-service.js";
export type {
  MemoryCorrectionCheck,
  MemoryCorrectionRequest,
  MemoryExtractionServiceConfig,
} from "./memory-extraction-service.js";
// S7.2 L5 — the one place a user's memories are listed, forgotten, paused or vetoed.
export { MemoryManagementService, MEMORY_FORGET_LIMIT, MEMORY_PAGE_LIMIT } from "./memory-management-service.js";
export type {
  MemoryAuditPort,
  MemoryControlStore,
  MemoryForgetAllOutcome,
  MemoryForgetOutcome,
  MemoryListOptions,
  MemoryManagementServiceConfig,
  MemoryStatus,
  MemoryTarget,
} from "./memory-management-service.js";
// Phase 14 — the bounded retention sweep.
export { MemoryRetentionSweep } from "./memory-retention-sweep.js";
export type { MemoryRetentionSweepConfig, MemoryRetentionSweepResult } from "./memory-retention-sweep.js";

export * from "./extraction/index.js";
export * from "./chunking/index.js";
export * from "./embedding/index.js";
export * from "./retrieval/index.js";

export { PrismaMemoryRepository } from "@jarvis/db";

export { OpenAIEmbeddingProvider } from "@jarvis/ai-openai";
export type { OpenAIEmbeddingConfig } from "@jarvis/ai-openai";

export type {
  IMemoryStore,
  MemoryType,
  MemoryRecord,
  MemoryStoreRequest,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryDeleteRequest,
  MemoryUpdateRequest,
  MemoryListRequest,
  MemoryListResult,
  MemoryCandidate,
  IEmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
  IMemoryExtractor,
  MemoryExtractionRequest,
  MemoryExtractionResult,
  ExtractionMessage,
  IDocumentExtractor,
  DocumentExtractionRequest,
  DocumentExtractionResult,
  ExtractedPage,
  ExtractedSection,
  ExtractedDocumentMetadata,
  SupportedDocumentFormat,
  DocumentFormatDescriptor,
  IDocumentChunker,
  ChunkingOptions,
  ResolvedChunkingOptions,
  ChunkSourceContext,
  ChunkBoundaryKind,
  ChunkSectionRef,
  DocumentChunk,
  DocumentChunkMetadata,
  DocumentChunkingResult,
  IDocumentEmbedder,
  DocumentEmbeddingOptions,
  ResolvedEmbeddingOptions,
  DocumentEmbeddingResult,
  DocumentEmbeddingUsage,
  ChunkEmbedding,
  SkippedChunk,
  EmbeddingSkipReason,
  IKnowledgeRetriever,
  KnowledgeRetrievalOptions,
  ResolvedRetrievalOptions,
  KnowledgeRetrievalFilters,
  KnowledgeRetrievalResult,
  RetrievedChunk,
  KnowledgeChunkSearchOptions,
  KnowledgeChunkMatch,
} from "@jarvis/core";
