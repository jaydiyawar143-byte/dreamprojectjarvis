export { MemoryManager } from "./memory-manager.js";
export { KnowledgeBase } from "./knowledge-base.js";
export { MemoryEngine } from "./memory-engine.js";
export type { MemoryEngineConfig } from "./memory-engine.js";
export { MemoryExtractionService } from "./memory-extraction-service.js";
export type { MemoryExtractionServiceConfig } from "./memory-extraction-service.js";

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
} from "@jarvis/core";
