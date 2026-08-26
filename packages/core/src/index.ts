export * from "./types/agent.js";
export * from "./types/tool.js";
export * from "./types/common.js";
export * from "./types/events.js";
export * from "./types/context.js";
export * from "./types/conversation.js";
export * from "./types/request.js";
export * from "./types/errors.js";
export * from "./types/streaming.js";
export * from "./types/execution.js";
export * from "./types/orchestrator.js";
export * from "./types/auth.js";
export * from "./types/ai-provider.js";
export * from "./types/memory.js";
export * from "./types/embedding-provider.js";
export * from "./types/meta-ads.js";
export * from "./types/tool-execution.js";
export * from "./types/reconciliation.js";
export * from "./lifecycle.js";
export * from "./startup-recovery.js";
export * from "./kpi-engine.js";
export * from "./types/performance-aggregation.js";
export * from "./performance-aggregator.js";
export * from "./types/anomaly-detection.js";
export * from "./anomaly-engine.js";
export * from "./types/diagnosis.js";
export * from "./evidence-builder.js";
export * from "./diagnosis-prompt.js";
export * from "./diagnosis-verification.js";
export * from "./diagnosis-engine.js";
export * from "./types/recommendation.js";
export * from "./recommendation-engine.js";
export * from "./types/outcome.js";
export * from "./outcome-engine.js";
export * from "./outcome-worker.js";
export * from "./historical-outcome-engine.js";
export * from "./recommendation-confidence.js";
export * from "./opportunity-scoring.js";
export * from "./opportunity-queue-service.js";
export * from "./utils/params-hash.js";
export * from "./utils/redact-secrets.js";

// Re-export deprecated memory-provider types under unique names for backward compat
export type {
  MemoryStoreRequest as LegacyMemoryStoreRequest,
  MemoryRecallRequest as LegacyMemoryRecallRequest,
  MemoryEntry as LegacyMemoryEntry,
  IMemoryProvider as LegacyIMemoryProvider,
} from "./types/memory-provider.js";
