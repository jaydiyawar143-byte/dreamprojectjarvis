import type { JarvisRequest, JarvisResponse } from "./request.js";
import type { SessionContext } from "./context.js";
import type { IMemoryStore } from "./memory.js";
import type { IMemoryExtractor } from "./memory.js";
import type { IEmbeddingProvider } from "./embedding-provider.js";
import type { ITool } from "./tool.js";
import type { IKnowledgeRetriever } from "./knowledge-retrieval.js";

// ---------------------------------------------------------------------------
// Memory Context Config — controls memory recall + extraction behavior
// ---------------------------------------------------------------------------

export interface MemoryContextConfig {
  /** Minimum semantic score threshold for memory relevance (0-1). Default: 0.3 */
  relevanceThreshold?: number;
  /** Maximum number of memories to inject into context. Default: 5 */
  maxMemories?: number;
  /** Maximum token-equivalent character budget for memory block. Default: 2000 */
  contextBudgetChars?: number;
  /** Enable async memory extraction after response. Default: true */
  extractionEnabled?: boolean;
  /** Expiry days for extracted memories. Default: 90 */
  extractionExpiryDays?: number;
}

// ---------------------------------------------------------------------------
// Knowledge Context Config (Sprint 3.7) — controls RAG retrieval + injection
// ---------------------------------------------------------------------------

export interface KnowledgeContextConfig {
  /** Master switch. Default: true whenever a retriever is configured. */
  enabled?: boolean;
  /** Maximum passages injected into the prompt. Default: 3 */
  maxChunks?: number;
  /**
   * Minimum cosine similarity for a passage to be injected (0-1). Default: 0.3
   *
   * Separate from the retrieval layer own floor: retrieval returns the nearest
   * chunks whatever they are, and this is the decision about whether the
   * nearest one is close enough to be worth showing the model.
   */
  minScore?: number;
  /** Character budget for the injected knowledge block. Default: 4000 */
  contextBudgetChars?: number;
}

// ---------------------------------------------------------------------------
// Tool Approval Service — gates tool execution behind approval
// ---------------------------------------------------------------------------

export interface IToolApprovalService {
  checkPreExecution(
    tool: ITool,
    params: Record<string, unknown>,
    request: {
      userId: string;
      role: string;
      executionId?: string;
      stepIndex?: number;
      traceId: string;
      conversationId?: string;
    }
  ): Promise<{
    allowed: boolean;
    requiresApproval: boolean;
    approvalId?: string;
    reason?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Orchestrator Config
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  maxToolExecutions?: number;
  maxOrchestrationDepth?: number;
  defaultTimeoutMs?: number;
  /** Memory store for recall. If undefined, memory is disabled. */
  memoryStore?: IMemoryStore;
  /** Memory extractor for async extraction after response. If undefined, extraction is disabled. */
  memoryExtractor?: IMemoryExtractor;
  /** Embedding provider for query embedding during recall. Required if memoryStore is provided. */
  embeddingProvider?: IEmbeddingProvider;
  /** Memory configuration. Only used if memoryStore is provided. */
  memory?: MemoryContextConfig;
  /** Tool registry for description injection and validation. */
  toolRegistry?: { get(toolId: string): ITool | undefined; getAll(): ITool[] };
  /** Tool approval service for pre-execution gates. */
  toolApprovalService?: IToolApprovalService;
  /**
   * Sprint 3.7 — knowledge retriever for RAG context injection.
   * If undefined, knowledge retrieval is disabled and the Orchestrator behaves
   * exactly as it did before.
   */
  knowledgeRetriever?: IKnowledgeRetriever;
  /** Knowledge configuration. Only used if knowledgeRetriever is provided. */
  knowledge?: KnowledgeContextConfig;
  /** Pending action service for write-tool confirmation flow. */
  pendingActionService?: unknown;
}

// ---------------------------------------------------------------------------
// IOrchestrator
// ---------------------------------------------------------------------------

export interface IOrchestrator {
  process(
    request: JarvisRequest,
    context: SessionContext
  ): Promise<JarvisResponse>;
}
