export { AgentRegistry, type AgentRegistryOptions } from "./registry.js";
export { BaseAgent } from "./base-agent.js";
export { DomainAgent, type DomainAgentConfig, type AgentAction } from "./domain-agent.js";
export { ConversationalAssistant } from "./agents/conversational-assistant.js";
export { MetaAdsAgent } from "./agents/meta-ads-agent.js";
export { KnowledgeAgent } from "./agents/knowledge-agent.js";
export { AnalyticsAgent } from "./agents/analytics-agent.js";
export {
  AutomationAgent,
  type AutomationAgentConfig,
  type WorkflowDirectory,
} from "./agents/automation-agent.js";
export {
  CommunicationAgent,
  type CommunicationAgentConfig,
  type ConversationDirectory,
  type ConversationDirectoryMessage,
} from "./agents/communication-agent.js";
export { GoogleAdsAgent } from "./agents/google-ads-agent.js";
export { BrowserAgent } from "./agents/browser-agent.js";
export { LocationAgent } from "./agents/location-agent.js";
export { Orchestrator } from "./orchestrator.js";
export { MockAIProvider } from "./mock-ai-provider.js";
export { ToolPlanValidator, ToolPlanParser, ToolDescriptionBuilder } from "./tool-planner.js";
export type { PlanValidationResult } from "./tool-planner.js";
export { PendingActionService } from "./pending-action-service.js";
export { detectIntent, isPendingActionExpired, approvalStatusToPendingState, summarizePendingAction } from "./intent-detector.js";

// Sprint 6 — server-authoritative agent policy and routing.
export {
  AGENT_IDS,
  AGENT_POLICIES,
  META_READ_TOOLS,
  META_WRITE_TOOLS,
  GOOGLE_READ_TOOLS,
  ANALYSIS_TOOLS,
  MAPS_TOOLS,
  AMBIENT_TOOLS,
  INTEGRATION_READ_TOOLS,
  INTEGRATION_WRITE_TOOLS,
  CAPABILITY_TOOLS,
  // Core V1 — self-description, and the task lifecycle grant.
  SELF_TOOLS,
  TASK_TOOLS,
  GOOGLE_WORKSPACE_TOOLS,
  GOOGLE_WRITE_PLAN_TOOLS,
  getAgentPolicy,
  isToolAllowed,
  resolveAllowedToolId,
  sanitizeToolName,
  scopedToolRegistry,
} from "./agent-policy.js";
// Task Planner V1.1 — is this turn a request to PERFORM work? Pure
// heuristic, no model call, same shape as the pending-action detector.
export { detectWorkRequest, type WorkRequest } from "./work-request-detector.js";
// Scheduler V1 — a closed grammar for explicit future times. Not a date parser.
export {
  parseSchedulePhrase,
  mentionsVagueTime,
  mentionsExplicitTime,
  SCHEDULE_ZONE,
  type SchedulePhrase,
} from "./schedule-phrase.js";

export {
  rankAgentCandidates,
  isAmbiguous,
  isMetaAdsQuery,
  type RouteCandidate,
} from "./agent-router.js";

export {
  shouldRetrieveKnowledge,
  selectKnowledgeChunks,
  formatKnowledgeBlock,
  describeSource,
  DEFAULT_MAX_KNOWLEDGE_CHUNKS,
  DEFAULT_KNOWLEDGE_MIN_SCORE,
  DEFAULT_KNOWLEDGE_BUDGET_CHARS,
} from "./knowledge-context.js";
