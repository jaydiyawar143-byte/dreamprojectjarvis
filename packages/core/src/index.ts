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
// R-26 / R-27 — shared by the model-provider adapters.
export * from "./provider-retry.js";
export * from "./provider-circuit-breaker.js";
// R-30 — the explicit provider chain the API wires every agent to.
export * from "./provider-fallback.js";
// R-31 — provider failures: fixed messages out, the provider's account logged.
export * from "./provider-error-safety.js";
// R-32 — raw provider insight rows -> normalised performance records.
export * from "./insight-rows.js";
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
// Core V1 — the task lifecycle (the single definition of legal transitions).
export * from "./types/task.js";
export * from "./capability-catalog.js";
// Skill System V1 — the outcome layer. Metadata only: a skill names an outcome
// and the tools behind it, and is executed the way everything else is, through
// the planner and ToolExecutor. There is deliberately no skill runtime.
export * from "./types/skill.js";
export * from "./capability-presentation.js";
// S5 — Execution Outcome & Evaluation. An OBSERVER: a pure projection over
// audit rows that already exist, plus the one explicit user signal. It
// executes nothing and feeds nothing back into planning.
export * from "./execution-outcome.js";
// S6 — Objective Evaluation, Phase 1: objective extraction. A fixed-rule
// reader of the user's own request, for a READ-ONLY evaluation after the fact.
// No model, no I/O; it decides, authorizes and plans nothing.
export * from "./objective-extraction.js";
// S6 — Phase 2: the pure evaluation builder. Joins those objectives to the
// server-written evidence of the same request under fixed rules. Read-only:
// it holds no executor, registry, policy, gate, planner, memory or model.
export * from "./objective-evaluation.js";
// S7.2 L1 — the learning-candidate contract. Pure fixed rules: what may never
// be learned (REJECT), what is not a candidate, what is clearly stable
// (ACCEPT = eligible, never a write) and what is UNDECIDED. Its only runtime
// consumer is MemoryExtractionService, in shadow mode (L1c-1).
export {
  decideLearningCandidate,
  LEARNING_RULES,
  type LearningCandidateInput,
  type LearningDecision,
  type LearningDecisionKind,
  type LearningRule,
  type LearningStatedBy,
} from "./learning-candidate.js";
// S7.2 L2 — learning provenance. Pure: a USER memory gets USER provenance
// (conversation, message, trace) from the service's own record of the cited
// message, or is refused. Its only runtime consumer is MemoryExtractionService.
export {
  PROVENANCE_REJECTIONS,
  PROVENANCE_SOURCE_TYPES,
  resolveUserProvenance,
  type LearningProvenance,
  type ProvenanceCitation,
  type ProvenanceRejection,
  type ProvenanceResolution,
  type ProvenanceSource,
  type ProvenanceSourceType,
} from "./learning-provenance.js";
// S7.2 L3 — learning validation and scope. Pure: does the user's own evidence
// establish a DURABLE memory? VALID + MEMORY is the only result ever stored;
// HOLD, INVALID and the GOAL/TASK/PROJECT/DECISION/TEMPORARY scopes never are.
// Its only runtime consumer is MemoryExtractionService.
export {
  isLearningValidationResult,
  LEARNING_CATEGORIES,
  LEARNING_SCOPES,
  LEARNING_VALIDATION_DECISIONS,
  LEARNING_VALIDATION_RULES,
  validateLearningCandidate,
  type LearningCategory,
  type LearningScope,
  type LearningValidationDecision,
  type LearningValidationInput,
  type LearningValidationResult,
  type LearningValidationRule,
} from "./learning-validation.js";
export * from "./speech-preparation.js";
export * from "./tool-failure-classifier.js";
export * from "./integration-health-snapshot.js";
export * from "./log-hash.js";
export * from "./utils/mask-identifier.js";
