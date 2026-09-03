export { MemoryManager } from "./memory-manager.js";
export { KnowledgeBase } from "./knowledge-base.js";
export { MemoryEngine } from "./memory-engine.js";
export type { MemoryEngineConfig } from "./memory-engine.js";
export { MemoryExtractionService } from "./memory-extraction-service.js";
export type { MemoryExtractionServiceConfig } from "./memory-extraction-service.js";

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
