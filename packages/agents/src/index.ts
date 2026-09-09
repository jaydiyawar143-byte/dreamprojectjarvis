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
  getAgentPolicy,
  isToolAllowed,
  resolveAllowedToolId,
  sanitizeToolName,
  scopedToolRegistry,
} from "./agent-policy.js";
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
