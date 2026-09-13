export * from "./types/agent.js";
export * from "./types/tool.js";
export * from "./types/common.js";
export * from "./types/events.js";
export * from "./types/context.js";
export * from "./types/conversation.js";
export * from "./types/request.js";
// Contextual surfaces. The schema in types/surface.ts is the security
// boundary: it is what stops a model emitting markup instead of a decision.
export * from "./types/surface.js";
export * from "./surface-registry.js";
export * from "./surface-intent.js";
export * from "./surface-decision.js";
export * from "./types/errors.js";
export * from "./types/streaming.js";
export * from "./types/execution.js";
export * from "./types/orchestrator.js";
export * from "./types/auth.js";
export * from "./types/ai-provider.js";
export * from "./types/memory.js";
export * from "./types/embedding-provider.js";
export * from "./types/meta-ads.js";
export * from "./types/google-ads.js";
export * from "./types/whatsapp.js";
export * from "./types/n8n.js";
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
export * from "./types/knowledge.js";
export * from "./types/document-extraction.js";
export * from "./types/document-chunking.js";
export * from "./types/document-embedding.js";
export * from "./types/knowledge-retrieval.js";
// Sprint 8.0 — voice interaction-layer contracts.
export * from "./types/voice.js";
// Sprint 7.0 — browser agent contracts.
export * from "./types/browser.js";
export * from "./utils/redact-secrets.js";
export * from "./utils/untrusted-content.js";

// Re-export deprecated memory-provider types under unique names for backward compat
export type {
  MemoryStoreRequest as LegacyMemoryStoreRequest,
  MemoryRecallRequest as LegacyMemoryRecallRequest,
  MemoryEntry as LegacyMemoryEntry,
  IMemoryProvider as LegacyIMemoryProvider,
} from "./types/memory-provider.js";
// Universal integration contract — the vocabulary the frontend, the JARVIS
// tools and the API all speak, so one command service can serve both paths.
export * from "./types/integration.js";
export * from "./integration-catalog.js";

// Capability discovery — what this build can do, and what can actually run now.
// Derived from the live tool registry, agent policies and integration state;
// never a hand-written feature list.
export * from "./types/capability.js";
// Phase 12 — real read-only Gmail, Drive and Calendar task contracts.
export * from "./types/google-workspace.js";
// Phase 13 — approval-gated Google write actions.
export * from "./types/google-write.js";
export * from "./capability-catalog.js";
export * from "./capability-presentation.js";
export * from "./speech-preparation.js";
export * from "./tool-failure-classifier.js";
export * from "./integration-health-snapshot.js";
export * from "./log-hash.js";
export * from "./utils/mask-identifier.js";
