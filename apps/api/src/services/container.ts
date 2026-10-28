import type { IOrchestrator, IToolExecutor, ITool, AIToolDefinition, ShutdownLifecycle, IMemoryStore, IEmbeddingProvider, IKnowledgeRetriever, IAIProvider, BrowserRuntimePort } from "@jarvis/core";
import { ExecutionOutcomeService } from "./execution-outcome-service.js";
import { ObjectiveEvaluationService } from "./objective-evaluation-service.js";
import type { TokenService } from "@jarvis/security";
import type { IMemoryExtractor } from "@jarvis/core";
import {
  Orchestrator,
  AgentRegistry,
  ConversationalAssistant,
  MetaAdsAgent,
  KnowledgeAgent,
  AnalyticsAgent,
  AutomationAgent,
  CommunicationAgent,
  GoogleAdsAgent,
  BrowserAgent,
  LocationAgent,
  MarketingAgent,
  PendingActionService,
  AGENT_IDS,
  AGENT_POLICIES,
  isToolAllowed,
  schedulableToolIds,
} from "@jarvis/agents";
import { createCurrentLocationPort, createMapsPort } from "./maps-adapter.js";
import {
  createMarketPort,
  createSystemPort,
  createTasksPort,
  createWeatherPort,
} from "./ambient-adapter.js";
import { MapsUsageGuard, resolveMonthlyLimit, setMapsUsageGuard } from "./maps-usage-guard.js";
import { OpenAIAdapter, OpenAIEmbeddingProvider, NotConfiguredAIProvider } from "@jarvis/ai-openai";
import { isOpenAIConfigured } from "@jarvis/config";
import {
  ToolExecutor,
  ToolRegistry,
  AnalysisGenerator,
  MetaAnalyzeTool,
  MetaGetAccountsTool,
  MetaGetCampaignsTool,
  MetaGetAdSetsTool,
  MetaGetAdsTool,
  MetaGetInsightsTool,
  MetaPauseCampaignTool,
  MetaResumeCampaignTool,
  MetaPauseAdSetTool,
  MetaResumeAdSetTool,
  MetaPauseAdTool,
  MetaResumeAdTool,
  MetaUpdateCampaignBudgetTool,
  MetaUpdateAdSetBudgetTool,
  MetaCreateCampaignTool,
  GoogleGetAccountsTool,
  GoogleGetCampaignsTool,
  GoogleGetInsightsTool,
  WhatsAppSendMessageTool,
  RepositoryRecipientAuthorizer,
  N8nTriggerWorkflowTool,
  createBrowserTools,
  createMapsTools,
  createAmbientTools,
} from "@jarvis/tools";
import {
  BrowserRuntime,
  createBrowserConfig,
  isBrowserEnabled,
  isBrowserConfigured,
  describeBrowserConfigStatus,
  // Phase 15 — one bounded read of a public page, under the same navigation policy.
  PublicPageFetcher,
  isPageResearchEnabled,
  pageResearchPolicy,
} from "@jarvis/browser";
import {
  BrowserServiceClient,
  RemoteBrowserRuntime,
  readBrowserServiceEndpoint,
} from "@jarvis/browser-protocol";
import { createMetaGraphProvider, createMetaPagePublisher, isPagePublishingEnabled } from "@jarvis/meta-graph";
import {
  createGoogleAdsProvider,
  createGoogleConfig,
  isGoogleConfigured,
  createGoogleOAuthConfig,
  isGoogleOAuthConfigured,
} from "@jarvis/google-ads";
import { createWhatsAppProvider, createWhatsAppConfig, isWhatsAppConfigured } from "@jarvis/whatsapp";
import {
  createN8nProvider,
  createN8nConfig,
  isN8nConfigured,
  createN8nMcpConfig,
  createN8nMcpConnector,
  isN8nMcpConfigured,
  type N8nMcpConnector,
  hashPayload,
  buildIdempotencyKey,
  createN8nLibraryPageSource,
  createN8nLibraryTriggerTargetSource,
  N8N_NODE_SCHEMA_SNAPSHOT,
} from "@jarvis/n8n";
import {
  PermissionService,
  ApprovalService,
  ToolApprovalService,
  TokenService as TokenServiceImpl,
  AuditLogger,
  PasswordHasher,
  AuthManager,
  EncryptionService,
} from "@jarvis/security";
import {
  prisma,
  PrismaAuditRepository,
  PrismaConversationRepository,
  PrismaUserRepository,
  PrismaRefreshTokenRepository,
  PrismaToolExecutionRepository,
  PrismaApprovalRepository,
  PrismaRecommendationRepository,
  PrismaMemoryRepository,
  PrismaKnowledgeRepository,
  PrismaGoogleConnectionRepository,
  PrismaWhatsAppRepository,
  PrismaN8nRepository,
  PrismaMapsUsageRepository,
  PrismaTaskRepository,
  type TaskRecord,
  PrismaIntegrationStateRepository,
  PrismaPreferenceRepository,
  PrismaProjectRepository,
  PrismaMarketingRepository,
  PrismaTenantRepository,
  PrismaAutomationLibraryRepository,
  PrismaAutomationDraftRepository,
} from "@jarvis/db";
import { MemoryExtractionService, KnowledgeRetrievalService, MemoryManagementService, MemoryRetentionSweep } from "@jarvis/memory";
import { createMemoryToolPort } from "./memory-tool-port.js";
import type { MemoryCorrectionCheckPort } from "../routes/memory-commands.js";
import { IntegrationCommandService } from "./integrations/command-service.js";
import { createIntegrationTools, type IntegrationCommandPort } from "@jarvis/tools";
import { createAutomationLibraryAllowlistTool, createAutomationLibraryTools, createAutomationPlanningTools } from "@jarvis/tools";
import { AutomationPlanningService } from "./automation-library/planning-service.js";
import { LibraryAllowlistFlow } from "./automation-library/allowlist-flow.js";
import { RecentTranscripts } from "./recent-transcripts.js";
import {
  createCapabilityTools,
  createMemoryCorrectionTool,
  createMemoryRetentionTool,
  createMemoryTools,
  createSelfTools,
  createTaskTools,
  type CapabilityPort,
  type SelfKnowledgePort,
  type TaskPort,
  type TaskView,
} from "@jarvis/tools";
import { TaskService } from "./tasks/task-service.js";
import { TaskExecutionService } from "./tasks/task-execution-service.js";
import { TaskPlannerService } from "./tasks/task-planner-service.js";
import { TaskConversationService } from "./tasks/task-conversation-service.js";
import { TaskSchedulerService } from "./tasks/task-scheduler-service.js";
import { SelfKnowledgeService } from "./self-knowledge/self-knowledge-service.js";
import { readBuildMetadata } from "./self-knowledge/build-metadata.js";
import { createGoogleWorkspaceTools, type GoogleWorkspaceTaskPort } from "@jarvis/tools";
import { createGoogleWriteTools, type GoogleWritePlanPort } from "@jarvis/tools";
import { GoogleWorkspaceTaskService } from "./google/workspace-service.js";
import { GoogleWriteService } from "./google/write-service.js";
import { buildGoogleWriteService } from "./google/build-write-service.js";
import { DbBackedRateLimiter } from "./rate-limiter.js";
import { CapabilityService } from "./capabilities/capability-service.js";
import {
  buildSkillContext,
  FallbackAIProvider,
  INTEGRATION_CATALOG,
  type ProviderChainEvent,
} from "@jarvis/core";
// S8.4 — MCP: the reviewed manifest, the runtime and the tool adapter.
import { MARKETING_PUBLISH_TOOL_IDS, MARKETING_RESEARCH_TOOL_IDS, MCP_MANIFEST, MEMORY_PURGE_TOOL_ID, validateMcpManifest, type McpManifest } from "@jarvis/core";
// Phase 18, Stage 18.5 — the trusted n8n node schemas: one verified snapshot,
// read once at start-up, shared by every surface that checks a draft.
import { loadNodeSchemaRegistry, type NodeSchemaRegistry } from "@jarvis/core";
import { randomUUID } from "node:crypto";
import { McpConnection, isMcpEnabled, HttpMcpConnection } from "@jarvis/mcp";
import { createMcpTools } from "@jarvis/tools";
// Phase 15 — the marketing workspace: one service, the tools that hold it as
// their port, and the publisher contract a provider package implements.
import {
  createMarketingDecisionTools,
  createMarketingPublishTools,
  createMarketingResearchTools,
  createMarketingWorkspaceTools,
  type ContentPublisher,
  type MarketingPort,
} from "@jarvis/tools";
import { MarketingService, PAGE_RESEARCH_OFF } from "./marketing/marketing-service.js";
import { googleAdsReportSource } from "./marketing/google-ads-source.js";
import { MarketingPublishFlow } from "./marketing/publish-flow.js";
import { AtomicRateLimiter, RATE_LIMIT_NAMESPACES } from "./rate-limiter.js";
import { buildIntegrationCommandService } from "./integrations/build.js";
import {
  SharedConnectionAccess,
  createBrowserSessionTenantResolver,
  createBrowserWriteScopeResolver,
  createSharedConnectionToolGate,
  type SharedConnectionAccessPort,
} from "./tenancy/shared-connection-access.js";
import { createOrganizationMetaAuthorizer, metaAccountFor } from "./tenancy/meta-ads-access.js";
import { errorMonitor, operationalLog } from "./observability/index.js";
import { mcpToolUnavailable } from "./integration-registry.js";
import { libraryInstanceKey, type LibraryPageSource, type LibraryTriggerTargetSource } from "@jarvis/core";
import { AutomationLibraryService, LIBRARY_SYNC_BUDGETS } from "./automation-library/library-service.js";

export interface Container {
  tokenService: TokenService;
  authService: AuthManager;
  orchestrator: IOrchestrator;
  conversationRepo: PrismaConversationRepository;
  auditLogger: AuditLogger;
  /**
   * S5 — Execution Outcome & Evaluation. An OBSERVER over `AuditLog`: it
   * derives what happened during a request and records the one explicit user
   * signal. It holds no registry, executor or policy, so it cannot run a tool,
   * and nothing in the planning path reads it back.
   */
  executionOutcomes: ExecutionOutcomeService;
  /**
   * S6 — Objective Evaluation. READ-ONLY: joins the objectives of one request
   * to the evidence the server wrote for it, under fixed rules. It holds two
   * readers and the registry's risk lookup — no executor, registry, policy,
   * gate or planner — and nothing in the planning path reads it back.
   */
  objectiveEvaluations: ObjectiveEvaluationService;
  /**
   * Phase 10.6 — durable execution journal (Prisma-backed), exposed so the
   * shutdown controller can run idempotent startup recovery and so hosts
   * never treat process memory as the source of truth.
   */
  executionJournal: PrismaToolExecutionRepository;
  /**
   * PHASE 10.7 — durable approval store backing the production approval API.
   */
  approvalRepo: PrismaApprovalRepository;
  /** Registry used by the approval flow to re-validate stored parameters. */
  toolRegistry: ToolRegistry;
  /**
   * THE single integration command path.
   *
   * Held on the container precisely so there is ONE instance: the REST router
   * and the JARVIS integration tools both receive this object, which is what
   * makes "a button and a sentence do the same thing" a fact about the object
   * graph rather than a claim in a comment. A second construction site would
   * quietly reintroduce the two-implementations problem this replaced.
   *
   * Null when JARVIS_ENCRYPTION_KEY is absent: without it no third-party
   * secret can be stored at rest, and storing one in plaintext is not an
   * acceptable fallback.
   */
  integrationCommands: IntegrationCommandService | null;
  /**
   * Capability discovery — the single source for "what can you do?".
   *
   * Shared by the REST route and the JARVIS capability tools for the same
   * reason the command service is: one instance means a page and a spoken
   * answer cannot disagree about what is available.
   */
  capabilities: CapabilityService | null;
  /**
   * Phase 12 — real read-only Gmail, Drive and Calendar tasks.
   *
   * One instance, shared by the REST routes and the JARVIS Workspace tools, so
   * a dashboard panel and a spoken request run the same checks. Null when the
   * server has no Google OAuth client or no encryption key: without either,
   * there is no connection to read from.
   */
  googleWorkspace: GoogleWorkspaceTaskService | null;
  /**
   * Phase 13 — approval-gated Google writes.
   *
   * One instance, shared by the REST routes, the JARVIS planning tools and the
   * approval execution path, so all three run the same gate. Null when this
   * deployment has no Google OAuth client or no encryption key; the routes and
   * tools then report NOT_CONFIGURED with the reason rather than 404ing.
   */
  googleWrites: GoogleWriteService | null;
  /**
   * UI V2 — the agent registry, exposed so `GET /api/v1/agents` can report which
   * agents ACTUALLY registered rather than which ones have a policy.
   *
   * The distinction matters: four of the eight agents register conditionally on
   * their integration being configured, so a UI reading only `AGENT_POLICIES`
   * would claim capabilities this deployment does not have.
   */
  agentRegistry: AgentRegistry;
  /**
   * PHASE 11.6B — executor exposed for recommendation execution route so
   * the RecommendationExecutionService can route all writes through the
   * SAME Phase 10 authority (approval + journal + concurrency).
   */
  executor: IToolExecutor;
  /**
   * PHASE 11.6B — durable recommendation store for the execution route.
   */
  recommendationRepo: PrismaRecommendationRepository;
  /**
   * PHASE 11.10 — the shared analysis / recommendation-generation service.
   *
   * One instance reached by BOTH the `meta.analyze` JARVIS tool and
   * `POST /api/v1/analysis`, after the same object-graph argument the
   * integration command service makes: a dashboard button and a spoken request
   * cannot disagree because there is no second implementation to disagree.
   *
   * Null when Meta is not configured or no AI provider is configured: analysis
   * needs both a token it can read through and a provider that can diagnose,
   * so the route reports ACCOUNT_NOT_CONFIGURED / AI_PROVIDER_NOT_CONFIGURED
   * instead of pointing both paths at a service that could only fail.
   */
  analysisService: AnalysisGenerator | null;
  /** Lifecycle gate consulted before approving side-effecting actions. */
  lifecycle?: ShutdownLifecycle;
  /** PHASE 11.9 — pending action service for write-tool confirmation flow. */
  pendingActionService?: import("@jarvis/agents").PendingActionService;
  /**
   * Sprint 1.1A — persistent memory store wired into the production container.
   * Null when OPENAI_API_KEY is absent (graceful degradation).
   */
  memoryStore: IMemoryStore | null;
  /** Sprint 1.1A — embedding provider. Null when OPENAI_API_KEY is absent. */
  embeddingProvider: IEmbeddingProvider | null;
  /** Sprint 1.1A — memory extractor. Null when OPENAI_API_KEY is absent. */
  memoryExtractor: IMemoryExtractor | null;
  /**
   * S7.2 L5 — the one place a user's memories are listed, forgotten, paused
   * or vetoed. Always present: it needs only the database, so a user can
   * manage what is stored even when learning is off for lack of a key.
   */
  memoryManagement: MemoryManagementService;
  /** Phase 14 — the user's own projects: the scope a memory may belong to. */
  projects: PrismaProjectRepository;
  /**
   * Phase 17 Stage 3A — tenant (Organization) READS: who owns a
   * deployment-wide connection, and an account's role in that tenant. Read on
   * every protected request, so a changed membership is in force at once.
   * Nothing in the runtime writes a tenant or a membership; the operator
   * command (apps/api/scripts/tenant-admin) does.
   */
  tenantRepo: PrismaTenantRepository;
  /**
   * Phase 17 multi-business hardening — who may see, test or use a connection
   * the deployment configures for everyone, read from the owner record and the
   * caller's membership on every call. The ONE instance: the Meta tools, the
   * executor's and the orchestrator's access gate, the Integration Control
   * Center and the dashboard's Meta pages all ask this object.
   */
  sharedAccess: SharedConnectionAccessPort;
  /**
   * Phase 14 — whether a statement may replace a memory, answered by the
   * memory writer. Absent when no writer is configured (no OPENAI_API_KEY).
   */
  memoryCorrections?: MemoryCorrectionCheckPort;
  /** Phase 14 — the bounded retention sweep. `index.ts` decides when it runs. */
  memoryRetention: MemoryRetentionSweep;
  knowledgeRepo?: PrismaKnowledgeRepository;
  /**
   * Sprint 3.7 — knowledge retriever wired into the orchestrator for RAG.
   * Null when OPENAI_API_KEY is absent, since a query cannot be embedded.
   */
  knowledgeRetriever: IKnowledgeRetriever | null;
  /**
   * Core V1 — the task lifecycle.
   *
   * The SAME instance the task tools hold, so `POST /api/v1/tasks` and
   * "JARVIS, remember this as a task" enforce one set of transition rules.
   */
  taskService: TaskService;
  /**
   * Task Execution V1 — PENDING -> RUNNING -> ToolExecutor -> COMPLETED/FAILED.
   *
   * Holds no execution machinery of its own: it sequences the SAME TaskService
   * and the SAME ToolExecutor this container already builds, so an executed
   * task passes every check a chat-initiated tool call passes.
   */
  taskExecution: TaskExecutionService;
  /**
   * Task Planner V1 — one task goal, one proposed tool call.
   *
   * Proposes only. It shares the executor's allowlist and the agent layer's
   * ToolPlanValidator, so a plan it produces is one `executeTask` will accept
   * and one the ToolExecutor will still permission-check and approval-gate.
   */
  taskPlanner: TaskPlannerService;
  /**
   * Task Planner V1.1 — the conversational entry point to work.
   *
   * Sequences the three services above for a chat turn that asks JARVIS to DO
   * something. Holds no authority of its own: a message that is not an
   * unambiguous work request never reaches it.
   */
  taskConversation: TaskConversationService;
  /**
   * Scheduler V1 — WHEN a pending work task runs.
   *
   * Sequences the same TaskService / Planner / Execution the immediate path
   * uses, so a scheduled run passes every check an explicit one does.
   */
  taskScheduler: TaskSchedulerService;
  /**
   * Core V1 — what JARVIS is: build, environment, model, capability counts.
   * Shared with the `self.describe` tool for the same reason.
   */
  selfKnowledge: SelfKnowledgeService;
  /**
   * Phase 15 — the marketing workspace.
   *
   * The SAME instance the marketing tools hold as their port. The Marketing
   * page's router does not call it to do work — it runs the tools through
   * `executor`, so a button passes the permission check, the approval gate and
   * the audit row a sentence passes. It is exposed for the two things a screen
   * must know before it draws a control: whether page research is switched on,
   * and which channels have a publisher.
   */
  marketing: MarketingService;
  /**
   * Phase 15 — publishing from the Marketing page: request an approval for the
   * exact parameters, then run the publish tool through `executor` naming that
   * approval. It holds no provider and decides nothing; see publish-flow.ts.
   */
  marketingPublishFlow: MarketingPublishFlow;
  /**
   * Phase 15 — why publishing is unavailable on this deployment, when it is:
   * switched off (MARKETING_PUBLISH_ENABLED), or switched on with nothing to
   * publish through. Null when a publisher is registered. For the screen.
   */
  marketingPublishingUnavailableReason: string | null;
  /**
   * Phase 15 — the role table, the SAME instance the executor checks against.
   * Exposed read-only so a route can tell a screen which controls a role could
   * use. It grants nothing: the executor still asks for itself.
   */
  permissions: PermissionService;
  /**
   * Phase 18, Stage 18.1 — the Automation Library: the persistent catalog of
   * the n8n instance's workflows, its synchronization and its status. The one
   * implementation; the library router only translates HTTP into its calls.
   */
  automationLibrary: AutomationLibraryService;
  /**
   * Phase 18.2 — what the server transcribed a moment ago, per account (hashes
   * only). The voice router remembers; the chat route marks a turn whose text
   * it recognises as spoken, so the execution layer refuses what speech may
   * not start even when a client leaves its own flag out.
   */
  recentTranscripts: RecentTranscripts;
  /**
   * Phase 18.3B — adds an approved library workflow to the trigger allow-list,
   * from the Automations page: names the approval and runs the page-only tool
   * through ToolExecutor. It approves and adds nothing itself.
   */
  automationLibraryAllowlist: LibraryAllowlistFlow;
  /**
   * Phase 18.4 — workflow planning: the library matched against a request,
   * and drafts held in JARVIS (never sent to n8n). The one implementation; the
   * planning router and the `automation.workflow.match` / `automation.draft.*`
   * tools are both given it.
   */
  automationPlanning: AutomationPlanningService;
}

/**
 * OpenAI function-calling requires names matching `^[a-zA-Z0-9_-]+$`.
 * Registry tool IDs use dots (e.g. `meta.insights`), so we sanitize them
 * for the LLM and build a reverse map so the orchestrator can resolve
 * the original ID when the model returns a tool call.
 */
function sanitizeToolName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function convertToolsToAIToolDefinitions(
  tools: ITool[]
): { definitions: AIToolDefinition[]; sanitizedToOriginal: Map<string, string> } {
  const sanitizedToOriginal = new Map<string, string>();
  const definitions = tools
    .filter((t) => t.enabled)
    .map((t) => {
      const sanitized = sanitizeToolName(t.id);
      if (sanitized !== t.id) {
        sanitizedToOriginal.set(sanitized, t.id);
      }
      return {
        name: sanitized,
        description: t.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            t.parameters.map((p) => [
              p.name,
              { type: p.type, description: p.description },
            ])
          ),
          required: t.parameters.filter((p) => p.required).map((p) => p.name),
        },
      };
    });
  return { definitions, sanitizedToOriginal };
}

/** R-30 — one JSON line per provider-chain event: a provider id and a code only. */
function logProviderChainEvent(event: ProviderChainEvent): void {
  const warn = event.event === "provider_failed_permanently" || event.event === "providers_exhausted";
  console.log(JSON.stringify({
    level: warn ? "warn" : "info",
    event: "ai_provider_chain",
    outcome: event.event,
    provider: event.provider,
    ...(event.cause ? { cause: event.cause } : {}),
  }));
}

let _container: Container | null = null;

/**
 * Sprint 7 — the shared browser, held so shutdown can close it.
 *
 * Module-scoped for the same reason `_container` is: the registry factory
 * creates it, but the process lifecycle is what has to end it, and threading a
 * return value out of the factory would change a signature the Sprint 6 drift
 * test pins.
 *
 * Phase 19.2: either the in-process runtime or a client for the isolated
 * browser service. Both are the same port, so the tools, their grants and
 * their approvals do not know or care where the session runs.
 */
let _browserRuntime: BrowserRuntimePort | null = null;

/**
 * S8.4 — one connection per reviewed MCP server, held so shutdown can close
 * them. Empty unless MCP is switched on. Module-scoped for the reason the
 * browser runtime is.
 */
let _mcpConnections: readonly McpConnection[] = [];

/**
 * S8.7 — the n8n MCP connector, or null when the surface is switched off.
 *
 * Held for the same reason the browser runtime and the MCP connections are: so
 * shutdown can close the HTTP session rather than orphaning it. It is built
 * here and never reached from a route — a caller goes through the connector's
 * own gate, and any action it takes is approval-gated above it.
 */
let _n8nMcpConnector: N8nMcpConnector | null = null;

/**
 * S8.5 — MCP as the integration layer sees it: the deployment switch, and the
 * managed connections tool calls use — never a second connection. Read late,
 * because the integration layer is built before the tools register. Handed to
 * the integration command service here and to the no-key route in index.ts.
 */
export const mcpIntegrationRuntime = Object.freeze({
  enabled: (): boolean => isMcpEnabled(),
  servers: (): readonly McpConnection[] => _mcpConnections,
});

/**
 * S8.4 — register the reviewed MCP tools, all or nothing.
 *
 * The manifest is validated as a whole against every tool already in the
 * registry, because the model-facing converter cannot detect a collision: an
 * invalid entry, a duplicate id, or a name that would collide with a
 * registered tool registers NOTHING — and nothing is renamed. Nothing is
 * spawned either: each server starts on its first tool call (S8.2's lazy
 * connection). Returns one connection per server, for shutdown.
 */
export function registerMcpTools(registry: ToolRegistry, manifest: McpManifest): McpConnection[] {
  const verdict = validateMcpManifest(manifest, { registeredToolIds: registry.getAll().map((t) => t.id) });
  if (!verdict.valid) {
    console.log(JSON.stringify({
      level: "warn",
      event: "mcp_registration_skipped",
      reason: "manifest_invalid",
      issues: [...new Set(verdict.issues.map((issue) => issue.code))],
    }));
    return [];
  }
  const connections = manifest.servers.map((server) => new McpConnection(server));
  const tools = manifest.servers.flatMap((server, i) => createMcpTools(server, connections[i]!));
  for (const tool of tools) registry.register(tool);
  console.log(JSON.stringify({
    level: "info",
    event: "mcp_tools_registered",
    servers: connections.length,
    tools: tools.length,
  }));
  return connections;
}

function createMetaToolRegistry(
  approvalConsumption: PrismaApprovalRepository,
  /**
   * The integration command service, when this deployment can hold secrets.
   *
   * Passed IN rather than constructed here so that the tools registered below
   * and the REST routes share one object. Null means no encryption key, in
   * which case the integration tools are not registered at all — an agent that
   * offers to connect Google on a server that cannot store the token would be
   * offering something it cannot do.
   */
  integrationCommands: IntegrationCommandService | null,
  /**
   * Capability discovery, or null when integration state cannot be read.
   *
   * Passed in for the same reason the command service is: the REST route and
   * these tools must share ONE instance, so a rendered page and a spoken answer
   * can never report different capabilities.
   */
  capabilities: CapabilityService | null,
  /** Phase 12 Workspace tasks, or null when Google cannot be connected here. */
  googleWorkspace: GoogleWorkspaceTaskService | null,
  /** Phase 13 write planning, or null when writes are unavailable here. */
  googleWrites: GoogleWriteService | null,
  /** Core V1 — the task lifecycle. Always present; it needs only the database. */
  tasks: TaskService,
  /** Core V1 — JARVIS describing itself. */
  selfKnowledge: SelfKnowledgePort,
  /**
   * Phase 17 (H2) — who may use the deployment's Meta connection. Every Meta
   * tool's account authorizer asks it, on every call.
   */
  sharedAccess: SharedConnectionAccessPort
): ToolRegistry {
  const registry = new ToolRegistry();
  // Phase 19.1 — the browser tools resolve the owning Organization through the
  // same reader as every other shared connection, on every approved write.
  const browserWriteScope = createBrowserWriteScopeResolver(sharedAccess);
  const metaAccessToken = process.env.META_ACCESS_TOKEN;
  const metaAccountId = process.env.META_AD_ACCOUNT_ID;

  console.log(JSON.stringify({
    level: "info",
    event: "meta_credentials_check",
    tokenSet: !!metaAccessToken,
    tokenLength: metaAccessToken?.length ?? 0,
    accountId: metaAccountId ?? "NOT_SET",
    apiVersion: process.env.META_GRAPH_API_VERSION ?? "NOT_SET",
  }));

  if (metaAccessToken && metaAccountId) {
    const realProvider = createMetaGraphProvider({
      accessToken: metaAccessToken,
      adAccountId: metaAccountId,
      apiVersion: process.env.META_GRAPH_API_VERSION,
    });

    // Phase 10.1: durable execution journal — DB-enforced idempotency for
    // every write tool. No in-process state may gate external side effects.
    const executionJournal = new PrismaToolExecutionRepository(prisma);

    // Phase 17 (H2) — the authorizer answers for the PERSON, not the token: a
    // member of the Organization that owns the Meta connection, with a role
    // that allows the read or the write, on the ONE account this deployment
    // gives that Organization. Only then is the provider asked whether the
    // token reaches it. The provider used to be its own authorizer, and it
    // never looked at the user.
    const authorizer = createOrganizationMetaAuthorizer({
      provider: realProvider,
      access: sharedAccess,
      configuredAccountId: metaAccountId,
    });

    // Phase 8: Read-only tools
    registry.register(new MetaGetAccountsTool(realProvider, authorizer));
    registry.register(new MetaGetCampaignsTool(realProvider, authorizer));
    registry.register(new MetaGetAdSetsTool(realProvider, authorizer));
    registry.register(new MetaGetAdsTool(realProvider, authorizer));
    registry.register(new MetaGetInsightsTool(realProvider, authorizer));

    // Phase 9.1: Write tools (pause/resume)
    registry.register(new MetaPauseCampaignTool(realProvider, authorizer, executionJournal, approvalConsumption));
    registry.register(new MetaResumeCampaignTool(realProvider, authorizer, executionJournal, approvalConsumption));
    registry.register(new MetaPauseAdSetTool(realProvider, authorizer, executionJournal, approvalConsumption));
    registry.register(new MetaResumeAdSetTool(realProvider, authorizer, executionJournal, approvalConsumption));
    registry.register(new MetaPauseAdTool(realProvider, authorizer, executionJournal, approvalConsumption));
    registry.register(new MetaResumeAdTool(realProvider, authorizer, executionJournal, approvalConsumption));

    // Phase 9.2: Budget tools
    registry.register(new MetaUpdateCampaignBudgetTool(realProvider, authorizer, undefined, executionJournal, approvalConsumption));
    registry.register(new MetaUpdateAdSetBudgetTool(realProvider, authorizer, undefined, executionJournal, approvalConsumption));

    // Phase 9.3: Campaign creation
    registry.register(new MetaCreateCampaignTool(realProvider, authorizer, undefined, executionJournal, approvalConsumption));
  }

  // -------------------------------------------------------------------------
  // Sprint 5.2 — Google Ads (READ-ONLY)
  // -------------------------------------------------------------------------
  // Registered only when the server is fully configured AND an encryption key
  // exists: without the key no connection could have been stored, so the tools
  // would fail on every call. Credentials are per-user and resolved inside the
  // provider, so nothing here handles a token.
  // -------------------------------------------------------------------------
  if (isGoogleConfigured() && process.env.JARVIS_ENCRYPTION_KEY) {
    try {
      const googleProvider = createGoogleAdsProvider({
        config: createGoogleConfig(),
        connections: new PrismaGoogleConnectionRepository(prisma, EncryptionService.fromEnv()),
      });
      // Provider doubles as its own authorizer, matching the Meta wiring.
      registry.register(new GoogleGetAccountsTool(googleProvider, googleProvider));
      registry.register(new GoogleGetCampaignsTool(googleProvider, googleProvider));
      registry.register(new GoogleGetInsightsTool(googleProvider, googleProvider));
    } catch (err) {
      // Misconfiguration must not take the whole API down; Google tools simply
      // stay unregistered and /google/status reports configured: false.
      console.log(JSON.stringify({
        level: "warn",
        event: "google_ads_registration_skipped",
        reason: err instanceof Error ? err.message : "unknown",
      }));
    }
  }

  // -------------------------------------------------------------------------
  // Sprint 5.3 — WhatsApp outbound send (APPROVAL-GATED)
  // -------------------------------------------------------------------------
  // Registered only when every WhatsApp secret is present. The tool is
  // EXTERNAL_SIDE_EFFECT with requiresApproval, so ToolApprovalService refuses
  // to execute it without a human decision — the same gate the Meta write
  // tools pass through.
  // -------------------------------------------------------------------------
  if (isWhatsAppConfigured()) {
    try {
      const waConfig = createWhatsAppConfig();
      const waRepo = new PrismaWhatsAppRepository(prisma);
      const waProvider = createWhatsAppProvider({ config: waConfig });
      registry.register(
        new WhatsAppSendMessageTool(
          waProvider,
          new RepositoryRecipientAuthorizer(waRepo, waConfig.phoneNumberId),
          waConfig.phoneNumberId,
          waRepo
        )
      );
    } catch (err) {
      // Misconfiguration must not take the API down; the tool stays
      // unregistered and the webhook routes report themselves unconfigured.
      console.log(JSON.stringify({
        level: "warn",
        event: "whatsapp_registration_skipped",
        reason: err instanceof Error ? err.message : "unknown",
      }));
    }
  }

  // -------------------------------------------------------------------------
  // Sprint 5.4 — n8n workflow trigger (APPROVAL-GATED)
  // -------------------------------------------------------------------------
  // Registered only when base URL, API key and callback secret are all set.
  // The tool is EXTERNAL_SIDE_EFFECT with requiresApproval: an n8n workflow can
  // do anything its author wired up, so ToolApprovalService demands a human
  // decision exactly as it does for the Meta write tools and whatsapp.send.
  // -------------------------------------------------------------------------
  if (isN8nConfigured()) {
    try {
      const n8nRepo = new PrismaN8nRepository(prisma);
      const n8nProvider = createN8nProvider({ config: createN8nConfig() });
      registry.register(
        new N8nTriggerWorkflowTool(n8nProvider, n8nRepo, { hashPayload, buildIdempotencyKey })
      );
    } catch (err) {
      console.log(JSON.stringify({
        level: "warn",
        event: "n8n_registration_skipped",
        reason: err instanceof Error ? err.message : "unknown",
      }));
    }
  }

  // -------------------------------------------------------------------------
  // S8.7 — n8n MCP, the SECOND n8n surface (discovery and invocation)
  // -------------------------------------------------------------------------
  // Off unless N8N_MCP_ENABLED=true AND an endpoint and token are present. It is
  // built here and never reached from a route: the connector owns the discovery
  // gate, and any action it takes is approval-gated above it, exactly as the
  // reviewed MCP servers are.
  //
  // Nothing connects at boot. Building the connector only validates config and
  // constructs an HTTP session object; the first request happens on the first
  // discovery, and a failure there is reported as a value rather than thrown
  // here — a deployment that switched MCP on but has not finished its OAuth
  // grant must still start, and say why discovery failed when asked.
  //
  // The transport is built in @jarvis/mcp and injected, so this package never
  // imports the MCP SDK — the boundary the package test holds.
  // -------------------------------------------------------------------------
  if (isN8nMcpConfigured()) {
    try {
      const mcpConfig = createN8nMcpConfig();
      const transport = new HttpMcpConnection({
        url: mcpConfig.endpoint,
        // A bearer token goes in a header and never in the URL, where it would
        // be written to every access log that captures a request line.
        headers: mcpConfig.token ? { Authorization: `Bearer ${mcpConfig.token}` } : {},
        allowedOrigins: mcpConfig.allowedOrigins,
        connectTimeoutMs: mcpConfig.timeoutMs,
        callTimeoutMs: mcpConfig.timeoutMs,
      });
      _n8nMcpConnector = createN8nMcpConnector(transport);
      operationalLog.child("n8n-mcp").info("n8n_mcp_configured", {
        // The ENDPOINT only. Never the token, which is a credential.
        endpoint: transport.url,
      });
    } catch (err) {
      _n8nMcpConnector = null;
      operationalLog.child("n8n-mcp").warn("n8n_mcp_registration_skipped", {
        // The configuration error names fields, never values.
        reason: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  // -------------------------------------------------------------------------
  // Sprint 7.3 — browser tools (READS OPEN, ACTIONS APPROVAL-GATED)
  // -------------------------------------------------------------------------
  // Mounted only when an operator has switched browsing on. Browsing is never
  // inferred from "a browser is installed", for the same reason Sprint 8
  // refused to infer voice from an OpenAI key being present: every machine has
  // one, and inferring would hand a live automation surface to deployments that
  // never asked for it.
  //
  // Phase 19.2 — two places a browser can run, one set of tools:
  //
  //   • BROWSER_SERVICE_URL set  → the isolated browser service. Chromium lives
  //     in its own process, image and network namespace; this process holds a
  //     signed client and no browser at all.
  //   • BROWSER_SERVICE_URL unset → the in-process runtime, exactly as before.
  //
  // A browser service URL that names an unusable configuration registers NO
  // tools. There is deliberately no fall back to the local browser: an operator
  // who asked for isolation and was given an in-process Chromium instead would
  // have been told the opposite of the truth.
  //
  // Where the browser may navigate is decided below the tools, in
  // @jarvis/browser or in the service's own runtime, so no prompt and no
  // request body can widen it.
  // -------------------------------------------------------------------------
  const browserService = readBrowserServiceEndpoint();
  if (!isBrowserEnabled()) {
    console.log(JSON.stringify({
      level: "info",
      event: "browser_tools_disabled",
      reason: describeBrowserConfigStatus().reason,
    }));
  } else if (browserService.state === "invalid") {
    // The operator configured a remote browser and got it wrong. Refusing here
    // keeps the failure visible: the tools are absent, so a request that needs
    // one is answered "not available", never silently run somewhere else.
    console.log(JSON.stringify({
      level: "warn",
      event: "browser_registration_skipped",
      reason: browserService.reason,
    }));
  } else if (browserService.state === "ready") {
    try {
      const client = new BrowserServiceClient({ config: browserService.config });
      const runtime = new RemoteBrowserRuntime({
        client,
        tenant: createBrowserSessionTenantResolver(sharedAccess),
      });
      _browserRuntime = runtime;

      const browserJournal = new PrismaToolExecutionRepository(prisma);
      for (const tool of createBrowserTools(runtime, browserJournal, approvalConsumption, browserWriteScope)) {
        registry.register(tool);
      }

      console.log(JSON.stringify({
        level: "info",
        event: "browser_tools_enabled",
        // The service's address is not a secret, but it is also not useful to
        // an operator reading logs; the host and port identify it.
        mode: "remote",
        serviceHost: new URL(browserService.config.baseUrl).host,
        timeoutMs: browserService.config.timeoutMs,
        mutualTls: browserService.config.tls !== null,
      }));
    } catch (err) {
      console.log(JSON.stringify({
        level: "warn",
        event: "browser_registration_skipped",
        reason: err instanceof Error ? err.message : "unknown",
      }));
    }
  } else if (isBrowserConfigured()) {
    try {
      const browserConfig = createBrowserConfig();
      const runtime = new BrowserRuntime({ config: browserConfig });
      _browserRuntime = runtime;

      const browserJournal = new PrismaToolExecutionRepository(prisma);
      for (const tool of createBrowserTools(runtime, browserJournal, approvalConsumption, browserWriteScope)) {
        registry.register(tool);
      }

      console.log(JSON.stringify({
        level: "info",
        event: "browser_tools_enabled",
        mode: "local",
        chromePath: browserConfig.chromePath,
        maxConcurrentSessions: browserConfig.maxConcurrentSessions,
        domainAllowlist: browserConfig.domainAllowlist.length,
      }));
    } catch (err) {
      // A misconfigured optional feature must not take the API down; the tools
      // stay unregistered and every other surface is unaffected.
      console.log(JSON.stringify({
        level: "warn",
        event: "browser_registration_skipped",
        reason: err instanceof Error ? err.message : "unknown",
      }));
    }
  } else {
    console.log(JSON.stringify({
      level: "info",
      event: "browser_tools_disabled",
      reason: describeBrowserConfigStatus().reason,
    }));
  }

  // -------------------------------------------------------------------------
  // Google Maps — place search, geocoding and routing (ALL READ-ONLY)
  // -------------------------------------------------------------------------
  // Registered UNCONDITIONALLY, unlike the integrations above, and that is the
  // deliberate difference: the geo layer answers from OpenStreetMap when no
  // Google server key is set, so these tools work on every deployment. Gating
  // them on a key would leave a user who asks "how far is Gondia" with an
  // assistant that has no tool for it — and a model with no tool for a factual
  // question is a model that guesses.
  //
  // Which provider actually answered is reported on every result, so an
  // OpenStreetMap distance is never described as a Google one.
  //
  // Nothing here can write, and nothing here takes a location from a model
  // parameter — see tools/maps-tools.ts.
  // -------------------------------------------------------------------------
  // The monthly cost ceiling is installed BEFORE the tools, so there is no
  // window in which a maps tool exists but is unmetered.
  setMapsUsageGuard(
    new MapsUsageGuard(new PrismaMapsUsageRepository(prisma), resolveMonthlyLimit())
  );

  const mapsPort = createMapsPort();
  const locationPort = createCurrentLocationPort();

  for (const tool of createMapsTools(mapsPort, locationPort)) {
    registry.register(tool);
  }

  // -------------------------------------------------------------------------
  // Ambient capability — weather, markets, and this machine.
  //
  // The dashboard widgets could already read all three. The ASSISTANT could
  // not, which left it fielding "aaj Solana ka kya price hai?" with no way to
  // look the number up — the exact position from which a language model invents
  // one. These run over the SAME cached providers the widgets call, so the
  // assistant and the dashboard can never disagree on screen.
  //
  // All READ_ONLY, no approval, no writes.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Integration management — the JARVIS arm of the two-path contract.
  //
  // These are what make "JARVIS, Gmail connection test karo" work, and they
  // reach the SAME IntegrationCommandService the Integrations page posts to.
  // The port below is the whole implementation: one method, forwarding an
  // already-typed command. There is deliberately no provider logic in it, so a
  // tool cannot acquire a capability the button does not have.
  // -------------------------------------------------------------------------
  if (integrationCommands) {
    const integrationPort: IntegrationCommandPort = {
      execute: (input, context) => integrationCommands.execute(input, context),
    };
    for (const tool of createIntegrationTools(integrationPort)) {
      registry.register(tool);
    }
  } else {
    console.log(JSON.stringify({
      level: "info",
      event: "integration_tools_disabled",
      reason: "JARVIS_ENCRYPTION_KEY is not set",
    }));
  }

  // -------------------------------------------------------------------------
  // Phase 12 — Gmail, Drive and Calendar reads.
  //
  // Registered whenever a Google connection is POSSIBLE, not only when one
  // exists: the tools must be present to answer "meri unread emails dikhao"
  // with "connect Google first". Gating registration on an existing connection
  // would make the request fall through to an agent with no tool for it, which
  // is how a model ends up inventing an answer.
  //
  // All READ_ONLY. There is no send, delete or create tool in this phase.
  // -------------------------------------------------------------------------
  if (googleWorkspace) {
    const workspacePort: GoogleWorkspaceTaskPort = {
      executeTask: (input, context) => googleWorkspace.executeTask(input, context),
    };
    for (const tool of createGoogleWorkspaceTools(workspacePort)) {
      registry.register(tool);
    }
  } else {
    console.log(JSON.stringify({
      level: "info",
      event: "google_workspace_tools_disabled",
      reason: "no Google OAuth client or no JARVIS_ENCRYPTION_KEY",
    }));
  }

  // -------------------------------------------------------------------------
  // Phase 13 — Google write PLANNING.
  //
  // Ten planners and no executors. The port handed to them exposes only
  // `plan`, so these tools cannot perform a Google write at all — execution
  // requires a human approving the row they create, consumed through
  // GoogleWriteService.execute() from the REST layer.
  //
  // Registered whenever writes are POSSIBLE, not only when a connection
  // exists, so "draft an email to Priya" can answer "connect Google first"
  // rather than falling through to an agent with no tool for it.
  // -------------------------------------------------------------------------
  if (googleWrites) {
    const writePlanPort: GoogleWritePlanPort = {
      plan: (action, params, planContext) => googleWrites.plan(action, params, planContext),
    };
    for (const tool of createGoogleWriteTools(writePlanPort)) {
      registry.register(tool);
    }
  } else {
    console.log(JSON.stringify({
      level: "info",
      event: "google_write_tools_disabled",
      reason: "no Google OAuth client or no JARVIS_ENCRYPTION_KEY",
    }));
  }

  // -------------------------------------------------------------------------
  // Capability discovery.
  //
  // Registered LAST, deliberately: its own report reads `registry.getAll()`, so
  // everything above is already present by the time it can be called. The
  // reader is a closure rather than a snapshot for the same reason — the
  // registry object exists now, its contents are finished a few lines later.
  //
  // These are what make "what can you do?" answerable from the system instead
  // of from a system prompt.
  // -------------------------------------------------------------------------
  if (capabilities) {
    const capabilityPort: CapabilityPort = {
      report: (userId) => capabilities.report(userId),
      forIntegration: (userId, id) => capabilities.forIntegration(userId, id),
      connectedIntegrations: (userId) => capabilities.connectedIntegrations(userId),
      permissions: (userId) => capabilities.permissions(userId),
    };
    for (const tool of createCapabilityTools(capabilityPort)) {
      registry.register(tool);
    }
  } else {
    console.log(JSON.stringify({
      level: "warn",
      event: "capability_tools_disabled",
      reason: "integration state unavailable (JARVIS_ENCRYPTION_KEY is not set)",
    }));
  }

  for (const tool of createAmbientTools(
    createWeatherPort(),
    createMarketPort(),
    createSystemPort(),
    mapsPort,
    locationPort,
    // The SAME repository the /tasks route uses, so the assistant and the
    // Tasks widget read one table through one query. The port scopes every
    // read to the authenticated caller.
    createTasksPort(new PrismaTaskRepository(prisma))
  )) {
    registry.register(tool);
  }

  // -------------------------------------------------------------------------
  // Core V1 — tasks, and JARVIS describing itself.
  //
  // Registered UNCONDITIONALLY. Both reach JARVIS's own database and nothing
  // else, so there is no credential that could be missing and no provider that
  // could be unconfigured — the failure mode that gates the integration tools
  // above simply does not exist here.
  //
  // The port is the boundary: `packages/tools` cannot import the database, so
  // these four methods are the entire write surface the model can reach, and
  // each one is already scoped to the authenticated caller by TaskService.
  // -------------------------------------------------------------------------
  const taskPort: TaskPort = {
    create: async (userId, input) => {
      const result = await tasks.createTask(userId, input);
      return result.ok
        ? { ok: true as const, task: toTaskView(result.task) }
        : { ok: false as const, message: result.message };
    },
    list: async (userId, options) =>
      (await tasks.listTasks(userId, options)).map(toTaskView),
    get: async (userId, taskId) => {
      const result = await tasks.getTask(userId, taskId);
      return result.ok
        ? { ok: true as const, task: toTaskView(result.task) }
        : { ok: false as const, message: result.message };
    },
    updateStatus: async (userId, taskId, status, error) => {
      // V2.3 - UNRESOLVED routed explicitly; see the note in routes/tasks.ts.
      const result =
        status === "RUNNING"
          ? await tasks.startTask(userId, taskId)
          : status === "COMPLETED"
            ? await tasks.completeTask(userId, taskId)
            : status === "UNRESOLVED"
              ? await tasks.unresolveTask(userId, taskId, error)
              : await tasks.failTask(userId, taskId, error);
      return result.ok
        ? { ok: true as const, task: toTaskView(result.task) }
        : { ok: false as const, message: result.message };
    },
  };

  for (const tool of createTaskTools(taskPort)) {
    registry.register(tool);
  }

  for (const tool of createSelfTools(selfKnowledge)) {
    registry.register(tool);
  }

  return registry;
}

/**
 * One task, as a model may see it.
 *
 * Dates become ISO strings and nothing else changes. `userId` is deliberately
 * NOT carried: the caller already is that user, and a tool result is the last
 * place an identifier should reappear.
 */
function toTaskView(task: TaskRecord): TaskView {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt ? task.startedAt.toISOString() : null,
    completedAt: task.completedAt ? task.completedAt.toISOString() : null,
    error: task.error,
  };
}

export function getContainer(options?: {
  /**
   * Phase 10.6 — lifecycle gate wired into the ToolExecutor so draining
   * blocks new side-effecting executions (and approval consumption) at the
   * earliest safe point.
   */
  lifecycle?: ShutdownLifecycle;
  /**
   * Task Engine V2.2 — how old a scheduler claim must be before it is treated
   * as abandoned. Supplied by the host from the validated config layer, the
   * same way `lifecycle` is, so this module needs no environment access of
   * its own. Omitted in tests, which take the service default.
   */
  claimRecoveryAfterMs?: number;
  /** Task Engine V2.3 - grace on top of the executor deadline. */
  runningRecoveryGraceMs?: number;
}): Container {
  if (_container) return _container;

  const tokenSecret = process.env.JWT_SECRET;
  if (!tokenSecret) {
    throw new Error("JWT_SECRET is required");
  }

  const tokenService = new TokenServiceImpl(tokenSecret);

  const auditRepo = new PrismaAuditRepository(prisma);
  const auditLogger = new AuditLogger(auditRepo);

  // Phase 10.6 — durable journal exposed on the container for idempotent
  // startup recovery and shutdown-time state inspection.
  const executionJournal = new PrismaToolExecutionRepository(prisma);

  const conversationRepo = new PrismaConversationRepository(prisma);

  const passwordHasher = new PasswordHasher();
  const userRepo = new PrismaUserRepository(prisma);
  const refreshTokenRepo = new PrismaRefreshTokenRepository(prisma);
  const authService = new AuthManager(passwordHasher, tokenService, refreshTokenRepo, userRepo);
  const knowledgeRepo = new PrismaKnowledgeRepository(prisma);

  const permissionService = new PermissionService();
  // PHASE 10.7 — real durable approval store replaces the Phase-0 noop repo.
  const approvalRepo = new PrismaApprovalRepository(prisma);
  const approvalService = new ApprovalService(approvalRepo);

  // Phase 17 — tenant READS, and the one answer to who may use a connection
  // the deployment configures for everyone. Built first: the integration
  // service, the Meta tools, the executor and the orchestrator all ask the
  // SAME object, so no surface can let through what another refuses.
  const tenantRepo = new PrismaTenantRepository(prisma);
  const sharedAccess = new SharedConnectionAccess(tenantRepo);
  const sharedToolGate = createSharedConnectionToolGate(sharedAccess);

  // Built BEFORE the tool registry, because the JARVIS integration tools are
  // registered into it and must be present when the agents' function
  // definitions are computed a few lines below. Its executor is bound after the
  // ToolExecutor exists — see `setExecutor` for why that circularity is real.
  const integrationCommands = buildIntegrationCommandService({
    prisma,
    auditLogger,
    mcp: mcpIntegrationRuntime,
    // Phase 13 — the command service and its confirmation store report through
    // the process's one log and one monitor.
    log: operationalLog,
    monitor: errorMonitor,
    sharedAccess,
  });

  // Capability discovery composes three things that already exist: the tool
  // registry (what is registered), the agent policies (what is reachable) and
  // the integration command service (what is actually connected, per user).
  // It adds no provider access of its own.
  const registryRef: { current: ToolRegistry | null } = { current: null };

  const capabilityService = integrationCommands
    ? new CapabilityService({
        // Lazy: the registry is populated moments after this object is built.
        toolRegistry: { getAll: () => registryRef.current?.getAll() ?? [] },
        integrations: {
          listIntegrations: async (userId: string) =>
            Promise.all(
              INTEGRATION_CATALOG.map((d) => integrationCommands.buildView(d.id, userId))
            ),
        },
        // A registered tool no policy grants cannot be triggered by any
        // conversation, so it is not a capability.
        allowedToolIds: new Set(
          Object.values(AGENT_POLICIES).flatMap((policy) => [...policy.allowedTools])
        ),
        // S8.7 — a reviewed MCP server that failed its last start or check is
        // presented as unavailable. Read from the managed connections tool
        // calls use; nothing is started, listed or verified to decide it.
        runtimeUnavailable: (toolId: string) => mcpToolUnavailable(mcpIntegrationRuntime.servers(), toolId),
      })
    : null;

  // Phase 12 — the Workspace task service. Built from the SAME encrypted
  // connection repository and the SAME OAuth config the integration layer uses;
  // it adds no second token store and no second consent flow.
  // Gated on the OAuth client ALONE. Gmail, Drive and Calendar need no Ads
  // developer token, so `isGoogleConfigured()` — which requires one — would
  // refuse Workspace access on a deployment fully able to provide it.
  const googleWorkspaceService =
    process.env.JARVIS_ENCRYPTION_KEY && isGoogleOAuthConfigured()
      ? (() => {
          try {
            return new GoogleWorkspaceTaskService({
              connections: new PrismaGoogleConnectionRepository(
                prisma,
                EncryptionService.fromEnv()
              ),
              config: createGoogleOAuthConfig(),
              audit: auditLogger,
              // Counted in the same audit-backed window every other limiter
              // uses, so the ceiling holds across processes.
              rateLimiter: new DbBackedRateLimiter(auditLogger, "google"),
              integrationState: {
                isEnabled: async (userId, integration) =>
                  (await new PrismaIntegrationStateRepository(prisma).get(userId, integration))
                    .enabled,
              },
            });
          } catch (err) {
            // Misconfiguration must not take the API down; Workspace tools
            // simply stay unregistered and capability discovery says so.
            console.log(JSON.stringify({
              level: "warn",
              event: "google_workspace_init_skipped",
              reason: err instanceof Error ? err.message : "unknown",
            }));
            return null;
          }
        })()
      : null;

  // Phase 13 — built from the SAME approval repository, execution journal,
  // encrypted vault and audit logger everything else uses. See
  // build-write-service.ts for the two adapters and why they are shaped as
  // they are.
  const googleWriteService = buildGoogleWriteService({ prisma, auditLogger });

  // Core V1 — the task lifecycle. One instance, shared by the REST route and
  // the task tools, for the same reason the integration command service is:
  // a button and a sentence must move the same task through the same rules.
  // ONE repository instance, shared by the lifecycle service and the
  // scheduler: the schedule columns and the status columns are the same rows.
  const taskRepository = new PrismaTaskRepository(prisma);
  const taskService = new TaskService({ tasks: taskRepository });

  // Core V1 — self-knowledge. The provider is built a few lines below, so its
  // identity is read through a ref rather than captured now; same lazy shape
  // as `registryRef` above, and for the same reason.
  const providerRef: { current: IAIProvider | null } = { current: null };
  const selfKnowledgeService = new SelfKnowledgeService({
    build: readBuildMetadata(),
    capabilities: capabilityService,
    model: {
      get id() {
        return providerRef.current?.id ?? "none";
      },
      get name() {
        return providerRef.current?.name ?? "Not configured";
      },
      get defaultModel() {
        return providerRef.current?.defaultModel ?? "none";
      },
      isAvailable: async () => providerRef.current?.isAvailable() ?? false,
    },
  });

  // Task Execution V1 — built AFTER the registry and executor exist, below.
  // Declared here so the Container literal can carry it.
  let taskExecutionService: TaskExecutionService | null = null;
  let taskPlannerService: TaskPlannerService | null = null;
  let taskConversationService: TaskConversationService | null = null;
  let taskSchedulerService: TaskSchedulerService | null = null;

  const toolRegistry = createMetaToolRegistry(
    approvalRepo,
    integrationCommands,
    capabilityService,
    googleWorkspaceService,
    googleWriteService,
    taskService,
    { describe: (userId) => selfKnowledgeService.describe(userId) },
    sharedAccess
  );
  registryRef.current = toolRegistry;

  // ---------------------------------------------------------------------------
  // S7.2 L5 — memory management.
  //
  // ONE memory repository instance, shared with the extraction wiring below —
  // no second store. The learning controls live in the existing per-user
  // settings table, namespaced like the command-center preferences.
  //
  // Registered here, before the agents' tool definitions are computed:
  // `memory.list` is granted to the general assistant. The two deleting tools
  // are granted to NO agent — they run only when the user confirms a pending
  // action the chat route created, through ToolExecutor, consuming its
  // approval in the same durable step that claims the execution.
  // ---------------------------------------------------------------------------
  const memoryRepository = new PrismaMemoryRepository(prisma);
  const memoryManagement = new MemoryManagementService({
    store: memoryRepository,
    // Phase 14 — "unreadable": a stored control document that is not valid
    // JSON is reported as PRESENT BUT UNREADABLE, which the contract reads as
    // paused. It used to be reported as absent — learning on, every veto gone.
    control: new PrismaPreferenceRepository(prisma, "prefs:memory", "unreadable"),
    audit: auditLogger,
  });

  // ---------------------------------------------------------------------------
  // Phase 14 — the tools' port, projects, correction and retention.
  //
  // Still ONE repository and ONE management service. The port only joins
  // them: `memory.list` is scoped to the conversation it is called in, and
  // `memory.correct` carries a confirmed correction to the memory writer —
  // built further down, hence the reference — which decides and writes.
  //
  // `memory.correct` and `memory.purge_expired` are registered here and
  // granted to NO agent, like the two deleting tools: the first runs only for
  // a pending action the user confirmed, the second only for the retention
  // sweep. Both run through ToolExecutor.
  // ---------------------------------------------------------------------------
  const projectRepo = new PrismaProjectRepository(prisma);
  const memoryWriter: { current: MemoryExtractionService | null } = { current: null };
  const memoryToolPort = createMemoryToolPort({
    memoryManagement,
    conversations: conversationRepo,
    corrector: () => memoryWriter.current,
  });
  for (const tool of createMemoryTools(memoryToolPort, executionJournal, approvalRepo)) {
    toolRegistry.register(tool);
  }
  toolRegistry.register(createMemoryCorrectionTool(memoryToolPort, executionJournal, approvalRepo));
  toolRegistry.register(createMemoryRetentionTool(memoryToolPort));

  // ---------------------------------------------------------------------------
  // S8.4 — MCP. Off unless JARVIS_MCP_ENABLED=true; the reviewed manifest is
  // the only source of servers and tools. Registered after the native tools
  // above, so collisions are checked against them, and before the agents'
  // definitions are computed below. (A native tool registered later cannot
  // collide: the `mcp` namespace is reserved to the manifest.) Nothing
  // connects at boot — a server starts on its first call, through ToolExecutor.
  // ---------------------------------------------------------------------------
  _mcpConnections = isMcpEnabled() ? registerMcpTools(toolRegistry, MCP_MANIFEST) : [];

  // R-21 — the adapter's constructor throws without a key, and this line used
  // to run unconditionally, so a server without one never opened its port. The
  // stand-in answers every conversation with AI_PROVIDER_NOT_CONFIGURED
  // instead. Production cannot get here without a key: `checkProductionConfig`
  // refuses to start it.
  const openAIConfigured = isOpenAIConfigured();
  //
  // R-30 — every agent gets the provider CHAIN, not the adapter. It holds one
  // provider until a fallback is chosen (decision D-3). A provider that fails
  // permanently is skipped for a cooldown and then probed; a request with no
  // usable provider gets AI_PROVIDER_UNAVAILABLE, and no agent is taken out of
  // service for it.
  const adapter: IAIProvider = openAIConfigured
    ? new FallbackAIProvider([new OpenAIAdapter()], {}, { onEvent: logProviderChainEvent })
    : new NotConfiguredAIProvider();
  // Self-knowledge can now name the model that will actually answer.
  providerRef.current = adapter;
  if (!openAIConfigured) {
    console.log(JSON.stringify({
      level: "warn",
      event: "ai_provider_disabled",
      reason: "OPENAI_API_KEY is not set",
    }));
  }

  // ---------------------------------------------------------------------------
  // PHASE 11.10 — `meta.analyze`, registered HERE, before the definitions the
  // agents are offered are computed a few lines below.
  //
  // It used to be registered at the very end of this function, once the
  // service it forwards to had been built — which was after those definitions
  // were taken. So the tool was in the registry, was granted to three agents
  // by policy, was listed as a capability, and was offered to no model: the
  // dashboard's Analyze button worked and "analyse my ad account" in chat
  // could not reach it (found in Phase 15, while checking Meta Ads analysis).
  //
  // The service needs the executor, which needs the registry, so it still
  // cannot be built yet. The tool is therefore given a port that looks the
  // service up when it is CALLED — the same late reference `registryRef` and
  // `memoryWriter` are. Registered on exactly the condition the service is
  // built on, so an agent is still never offered an analysis it cannot run.
  // ---------------------------------------------------------------------------
  const analysisRef: { current: AnalysisGenerator | null } = { current: null };
  const analysisPossible = Boolean(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID && openAIConfigured);
  if (analysisPossible) {
    toolRegistry.register(
      new MetaAnalyzeTool(
        {
          analyze: (input, caller) => {
            const service = analysisRef.current;
            // Unreachable once this function has returned; the tool turns a
            // throw into a plain failure, never into a verdict.
            if (!service) throw new Error("analysis service is not ready");
            return service.analyze(input, caller);
          },
        },
        process.env.META_AD_ACCOUNT_ID
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Phase 15 — the marketing workspace.
  //
  // ONE MarketingService. The tools registered below hold it as their port,
  // and the Marketing page's router runs those same tools through the
  // executor — so a sentence and a button reach this object by one road.
  //
  // WHAT IT IS GIVEN, AND WHAT IT IS NOT.
  //   - the marketing repository, projects and conversations: JARVIS's own
  //     database, for its rows and for the scope a conversation implies;
  //   - the EXECUTOR, by late reference, and nothing else of Meta: a report
  //     reads the ad account by running the registered read tools, exactly as
  //     AnalysisGenerator does. It holds no provider and no token;
  //   - a page reader ONLY when the operator has switched page reads on — the
  //     same BROWSER_ENABLED that governs browsing, under the same domain
  //     allowlist — and null otherwise;
  //   - the publishers that exist. Today that is one: a Facebook Page
  //     publisher, built only when the Meta integration is configured.
  //
  // THREE REGISTRATIONS, THREE CONDITIONS.
  //   workspace tools   always. They reach the database and nothing else.
  //   research tools    only with a page reader. Without one they are absent,
  //                     and capability discovery says so.
  //   publish tools     only with a publisher — and a publisher exists only
  //                     where the operator switched publishing ON
  //                     (MARKETING_PUBLISH_ENABLED=true) AND the Meta
  //                     integration is configured. Off by default: the
  //                     credentials that read the ad account must not, on
  //                     their own, make a deployment able to post publicly.
  //                     With no publisher there is no publish tool for a
  //                     sentence or a button to reach, so no approval for a
  //                     publish can come to exist.
  //
  // Registered here, before the agents' definitions are computed.
  // ---------------------------------------------------------------------------
  const executorRef: { current: IToolExecutor | null } = { current: null };

  const publishingSwitchedOn = isPagePublishingEnabled();
  const marketingPublishers: ContentPublisher[] = [];
  if (publishingSwitchedOn && process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID) {
    marketingPublishers.push(
      createMetaPagePublisher({
        accessToken: process.env.META_ACCESS_TOKEN,
        apiVersion: process.env.META_GRAPH_API_VERSION,
      })
    );
  }

  const pageReader = isPageResearchEnabled() ? new PublicPageFetcher({ policy: pageResearchPolicy() }) : null;

  const marketingService = new MarketingService({
    store: new PrismaMarketingRepository(prisma),
    projects: projectRepo,
    conversations: conversationRepo,
    executor: () => executorRef.current,
    // The configured ad account, and only where its read tools registered.
    // Phase 17 (L11) — and only for a member of the Organization that owns
    // the Meta connection; for anyone else there is none. A check that cannot
    // be made is not a "no": it throws, and the report says it could not read.
    metaAccount: (userId) =>
      metaAccountFor(sharedAccess, userId, toolRegistry.get("meta.insights") !== undefined ? process.env.META_AD_ACCOUNT_ID : null),
    googleAds: (userId) => googleAdsReportSource(capabilityService, userId),
    pages: pageReader,
    publishers: marketingPublishers,
    audit: auditLogger,
    // A slot is RESERVED in the audit table before a page read, a report or a
    // publish check starts — count and reservation in one step, in PostgreSQL,
    // so the ceilings hold for requests that arrive together and across
    // processes.
    limiter: new AtomicRateLimiter(auditRepo, RATE_LIMIT_NAMESPACES.marketing),
  });
  const marketingPort: MarketingPort = marketingService;

  for (const tool of createMarketingWorkspaceTools(marketingPort)) toolRegistry.register(tool);
  if (pageReader) {
    for (const tool of createMarketingResearchTools(marketingPort)) toolRegistry.register(tool);
  }
  if (marketingPublishers.length > 0) {
    // The same journal and the same approval store the Meta and memory write
    // tools use: a publish consumes its approval in the durable step that
    // claims its execution.
    for (const tool of createMarketingPublishTools(marketingPort, executionJournal, approvalRepo)) toolRegistry.register(tool);
    // A person's decision about a publish whose outcome is not known. In the
    // registry so the page reaches it through the executor; on no agent's
    // allowlist, so no model is offered it.
    for (const tool of createMarketingDecisionTools(marketingPort)) toolRegistry.register(tool);
  }

  // ---------------------------------------------------------------------------
  // Phase 18, Stage 18.1 — the Automation Library.
  //
  // A persistent catalog of the n8n instance's workflows, synchronized in
  // bounded, resumable runs. Built on every deployment so its routes can say
  // what is missing; it reads n8n only when n8n is configured, through the same
  // read-only listing the rest of the server uses. The catalog belongs to the
  // Organization that owns the n8n REST connection, and the instance is named by
  // a hash of its base URL — the URL itself is never stored. A run's start takes
  // a slot per account and per catalog before n8n is called, and a stopping
  // server ends a run at its next page boundary with its place saved.
  //
  // Stage 18.2 — built here, before the registry is read for the agents'
  // definitions, because the JARVIS tools `automation.library.*` hold this
  // one instance as their port: the routes and the tools share it, so a
  // sentence and a button meet the same authorization, budgets and refusals.
  // The sync tool is refused for a spoken turn by the executor itself.
  // ---------------------------------------------------------------------------
  let librarySource: { pages: LibraryPageSource; instanceKey: string } | null = null;
  // Stage 18.3B — the one live read an approved allow-list change makes.
  let libraryTriggerTargets: LibraryTriggerTargetSource | null = null;
  if (isN8nConfigured()) {
    try {
      const n8nConfig = createN8nConfig();
      const instanceKey = libraryInstanceKey(n8nConfig.baseUrl);
      if (instanceKey) {
        const n8nApi = createN8nProvider({ config: n8nConfig });
        librarySource = { pages: createN8nLibraryPageSource(n8nApi), instanceKey };
        libraryTriggerTargets = createN8nLibraryTriggerTargetSource(n8nApi);
      }
    } catch {
      operationalLog.child("automation-library").warn("automation_library_source_unavailable", { reason: "n8n configuration is invalid" });
    }
  }
  const librarySlots = new AtomicRateLimiter(auditRepo, RATE_LIMIT_NAMESPACES.automation_library);
  const libraryStore = new PrismaAutomationLibraryRepository(prisma);
  const automationLibrary = new AutomationLibraryService({
    store: libraryStore,
    access: sharedAccess,
    source: librarySource,
    budget: {
      reserveForUser: (userId) =>
        librarySlots.reserve(userId, "sync_slot", LIBRARY_SYNC_BUDGETS.perUser.limit, LIBRARY_SYNC_BUDGETS.perUser.windowMs),
      reserveForOrganization: (scope, userId) =>
        librarySlots.reserveShared(
          `sync_budget.${scope.tenantId}.${scope.instanceKey}`,
          userId,
          LIBRARY_SYNC_BUDGETS.perOrganization.limit,
          LIBRARY_SYNC_BUDGETS.perOrganization.windowMs
        ),
    },
    audit: auditLogger,
    shouldStop: () => options?.lifecycle?.isShuttingDown() ?? false,
    log: operationalLog.child("automation-library"),
    // Stage 18.3B — a proposal is an approval row in the one approval store
    // (which binds it to the Organization that owns n8n); the allow-list is
    // the existing per-account `N8nWorkflow` table.
    approvals: approvalRepo,
    allowlist: new PrismaN8nRepository(prisma),
    triggerTargets: libraryTriggerTargets,
  });
  for (const tool of createAutomationLibraryTools(automationLibrary)) toolRegistry.register(tool);
  // The page-only change: registered so the executor can run it, granted to no
  // agent. It consumes its approval in the journal's durable step.
  toolRegistry.register(createAutomationLibraryAllowlistTool(automationLibrary, executionJournal, approvalRepo));
  // Stage 18.4 — planning: the library's own authorization and store, and the
  // drafts table. Nothing in it holds an n8n client.
  // Stage 18.5 — the trusted n8n node schemas. The snapshot is verified once,
  // here: a file that does not match its own hash is refused whole, and then
  // no draft is checked against it. One instance, so the page's router and the
  // JARVIS tools are answered alike.
  const nodeSchemaLoad = loadNodeSchemaRegistry(N8N_NODE_SCHEMA_SNAPSHOT);
  const nodeSchema: NodeSchemaRegistry | null = nodeSchemaLoad.ok ? nodeSchemaLoad.registry : null;
  if (nodeSchema === null) {
    operationalLog.child("automation-planning").warn("automation_node_schema_untrusted", {
      reason: nodeSchemaLoad.ok ? "the snapshot was refused" : nodeSchemaLoad.reason,
    });
  }
  const automationPlanning = new AutomationPlanningService({
    catalog: automationLibrary,
    entries: libraryStore,
    drafts: new PrismaAutomationDraftRepository(prisma),
    audit: auditLogger,
    log: operationalLog.child("automation-planning"),
    nodeSchema,
  });
  for (const tool of createAutomationPlanningTools(automationPlanning)) toolRegistry.register(tool);
  const marketingPublishingUnavailableReason =
    marketingPublishers.length > 0
      ? null
      : publishingSwitchedOn
        ? "Publishing is switched on, but no publishing connection is configured on this server."
        : "Publishing is switched off on this server. An administrator can switch it on by setting MARKETING_PUBLISH_ENABLED=true and restarting.";
  // The same sentence, for a conversation. The marketing agent's policy still
  // names the two publish tools — a grant is compile-time — so a model can name
  // one on a server that did not register it. The orchestrator is told which
  // tools are switched off and why, and answers such a call with this sentence
  // instead of handing the executor a tool that is not there. Empty where the
  // tools ARE registered: a tool that exists is never looked up in it.
  const marketingSwitchedOffTools: Record<string, string> = {};
  if (marketingPublishingUnavailableReason !== null) {
    for (const id of MARKETING_PUBLISH_TOOL_IDS) {
      if (toolRegistry.get(id) === undefined) marketingSwitchedOffTools[id] = marketingPublishingUnavailableReason;
    }
  }
  // The two page reads are in the same position wherever `BROWSER_ENABLED` is
  // not `true`: granted to the marketing agent and to the general assistant,
  // registered nowhere. A model that named one got "Tool not found" and a
  // failed turn. They are named here too, with the sentence the service gives
  // when it is asked for a page read it cannot make.
  if (!pageReader) {
    for (const id of MARKETING_RESEARCH_TOOL_IDS) {
      if (toolRegistry.get(id) === undefined) marketingSwitchedOffTools[id] = PAGE_RESEARCH_OFF;
    }
  }
  // A start-up event an operator checks after a deploy (docs/DEPLOYMENT.md), so
  // it goes through the operational log: timestamped, attributed, redacted.
  operationalLog.child("marketing").info("marketing_wiring", {
    pageResearch: pageReader ? "enabled" : "disabled (BROWSER_ENABLED is not set to true)",
    publishing: publishingSwitchedOn ? "enabled" : "disabled (MARKETING_PUBLISH_ENABLED is not set to true)",
    publishers: marketingPublishers.map((publisher) => `${publisher.provider}:${publisher.channel}`),
  });

  const { definitions: agentTools, sanitizedToOriginal } = convertToolsToAIToolDefinitions(toolRegistry.getAll());

  // Sprint 6 — narrow the definitions offered to each agent to its policy.
  // `agentTools` holds SANITIZED names (dots are illegal in an OpenAI function
  // name), so membership is tested with the helper that understands both
  // spellings rather than by string equality against the registry ids.
  const registeredToolIds = new Set(toolRegistry.getAll().map((t) => t.id));
  const hasTool = (id: string) => registeredToolIds.has(id);
  const toolDefsFor = (allowed: readonly string[]): AIToolDefinition[] =>
    agentTools.filter((def) => isToolAllowed(def.name, allowed));

  // -------------------------------------------------------------------------
  // The general assistant's system prompt.
  //
  // ROOT CAUSE THIS REPLACES. This prompt used to open with "You are JARVIS, a
  // helpful AI assistant with direct access to the user's Meta Ads account" and
  // then describe only Meta tooling. Because this agent is the ROUTING
  // FALLBACK — every message matching no domain signal lands here, including
  // "what can you do?" — that identity became the answer to every capability
  // question, on every deployment, regardless of what was registered or
  // connected. It also listed Gmail actions on servers with no Google OAuth
  // client, because a prompt cannot know that and was never asked to.
  //
  // The fix is not better wording. It is removing the claim entirely: this
  // agent no longer describes its own capabilities at all, and is instead
  // required to call `get_available_capabilities`, which derives the answer
  // from the live tool registry and the user's real integration state.
  //
  // Phase 17 (review finding L11) — the Meta account id is NOT in this prompt.
  // The prompt is built once and handed to every account's conversation, so
  // an id in it was the operator's identifier in front of everyone, member or
  // not. The model learns it from `meta.accounts`, which returns it only to a
  // member of the Organization that owns the Meta connection — and nothing to
  // anyone else. The chat route still masks identifiers on the way out.
  // -------------------------------------------------------------------------
  const systemPrompt = [
    "You are JARVIS, a personal AI operating system. You are a general-purpose assistant with many tools across several domains — advertising, maps and location, web browsing, automations, messaging, documents, and your own integration management.",
    "",
    "=== CAPABILITY QUESTIONS: ALWAYS USE THE TOOL ===",
    "You do NOT know what you can do. Your tools and your connected integrations differ per deployment and per user, and change at runtime.",
    "For ANY question about your capabilities, tools, features, permissions or what is connected — including 'what can you do', 'tum kya kar sakte ho', 'available tools batao', 'what are your features', 'mere tools aur permissions batao' — you MUST call `get_available_capabilities` (registry id `capabilities.list`) and answer from its result.",
    "NEVER answer a capability question from memory, from this prompt, or from what you have seen in the conversation. You do not have that information; the tool does.",
    "Related tools, to be used in preference to guessing:",
    "- `capabilities.connected` — which integrations are actually connected.",
    "- `capabilities.integration` — what can be done with ONE integration (gmail, drive, maps, meta, …).",
    "- `capabilities.permissions` — which permissions are granted versus merely known.",
    "",
    "=== ANSWERING A CAPABILITY QUESTION ===",
    "`capabilities.list` returns a BRIEFING, not a list to read out. Turn it into a short, natural answer:",
    "- Open with its `intro`, in your own words.",
    "- Walk through the `whatICanDo` areas — the `area` heading and the `youCanAsk` phrasings, as flowing prose or a few short bullets.",
    "- Offer three to six of the `tryAsking` examples verbatim, as things the user can say.",
    "- State `howApprovalWorks` in one sentence when it is present.",
    "- Mention `notAvailableYet` ONLY if it is relevant to what the user asked, with the fix.",
    "Write it the way a capable assistant would answer a person: warm, brief, concrete.",
    "PLAIN TEXT ONLY. The chat renders your reply verbatim — it has no markdown parser — so markdown syntax is shown to the user as literal characters.",
    "Write '- Business and advertising: I can ...', NEVER '- **Business and advertising**: I can ...' and NEVER '### Business and advertising'.",
    "Asterisks, hash marks, backticks and pipes must not appear anywhere in your reply. Use short paragraphs and simple '-' bullets only.",
    "NEVER print tool names, registry ids, JSON, availability enum values or capability counts. NEVER number every item. NEVER say how many capabilities you have.",
    "Never merge the lists. `notAvailableYet` and `plannedNotBuilt` are things you CANNOT do — report them with their reason, never as available. If an integration is not connected, say so and give the required action.",
    "",
    "=== A SPECIFIC REQUEST IS NOT A CAPABILITY QUESTION ===",
    "If the user asks you to DO something specific — 'mere Meta campaigns ke insights batao', 'nearby restaurants dhundo', 'check my system health' — that is a task, not a capability question.",
    "Do the task: pick the right tool and call it. Do NOT call `capabilities.list`, and do NOT answer with a list of what you can do.",
    "Ask a clarifying question only when something is genuinely missing and you cannot reasonably infer it.",
    "",
    "=== NEVER REVEAL IDENTIFIERS ===",
    "Never print a full account id, customer id, phone number id, token, API key or webhook secret in your reply, even when a tool result contains one.",
    "When you must refer to an account, use a masked form (for example act_2478••••••1624) or just the provider name.",
    "",
    "=== THE META ACCOUNT ID COMES FROM A TOOL ===",
    "Before any Meta tool call that takes an \"accountId\", call the Meta accounts tool (registry id `meta.accounts`) and pass exactly the accountId it returns. That is the ONLY valid account id for this user.",
    "If it returns no account, Meta Ads is not available to this user: say so plainly, and do not call another Meta tool.",
    "Never invent one, never guess one, and never copy an example id out of a tool's parameter description — an example in documentation is not a real account and the call will be refused.",
    "Use it as a PARAMETER only — never display it, never repeat it back to the user, and never include it in prose.",
    "",
    "=== USING TOOLS FOR FACTS ===",
    "Never invent, estimate or fabricate data of any kind — metrics, distances, prices, statuses, ids. If a fact requires a tool, call the tool.",
    "Only report data a tool actually returned. Check each tool result's STATUS field.",
    "If a tool's STATUS is not COMPLETED, or DATA_RETRIEVAL_FAILED appears, state plainly that retrieval failed and include the tool's ERROR. Do NOT present any values as factual.",
    "If a tool returns no data, say no data was found for those criteria.",
    "Include provenance when presenting provider data: which provider answered, and the date range.",
    "",
    "=== ADVERTISING DATA (when asked) ===",
    "For Meta or Google Ads questions, fetch real data with the appropriate read tool rather than describing what you could do.",
    "DATE RANGE DEFAULTS: 'current'/'recent'/unspecified -> last 30 days; 'this week' -> last 7 days; 'this month' -> first of this month to today; 'last month' -> the whole previous month. Always YYYY-MM-DD. Do not ask for dates you can reasonably infer.",
    "",
    "=== WRITES AND APPROVALS ===",
    "For write operations, call the tool directly. The system intercepts it, creates a pending action and runs the confirmation and approval flow.",
    "When the system returns a pending action, present the details and ask the user to confirm. NEVER say 'I cannot proceed' — a pending action is the normal workflow.",
    "When the user confirms ('haan kar do', 'yes', 'go ahead'), the system executes it; you do not call the tool again.",
    "Never claim a mutation happened without a tool result confirming it.",
    "",
    "=== MULTI-TURN CONTEXT ===",
    "You have the full conversation history. Resolve short follow-ups ('yes', 'kar do', 'proceed', 'same', 'nahi tum karo') against the immediately preceding context.",
    "NEVER re-ask for information already provided. If everything needed is present, proceed. If something is genuinely missing, ask only for that.",
    "Do not invent or guess values the user has not provided.",
    "",
    "=== LANGUAGE ===",
    "Reply in the language and register the user wrote in — English, Hindi or Hinglish. Keep technical identifiers in English.",
  ].join("\n");

  const agent = new ConversationalAssistant({
    provider: adapter,
    systemPrompt,
    tools: toolDefsFor(AGENT_POLICIES[AGENT_IDS.general]!.allowedTools),
  });

  const metaAdsSystemPrompt = [
    "You are the JARVIS Meta Ads Agent, a specialized domain expert for Meta Ads (Facebook & Instagram).",
    "You have campaign hierarchy awareness: Account -> Campaign -> Ad Set -> Ad -> Creative.",
    "You understand performance metrics: Spend, CTR, CPC, CPM, CPA, ROAS, Conversions, Budget, and Delivery states.",
    "",
    "=== REASONING & ACCURACY RULES ===",
    "1. FACT vs INFERENCE vs HYPOTHESIS: Clearly distinguish verified facts from logical inferences and hypotheses.",
    "   - FACT: Data directly returned from a tool.",
    "   - INFERENCE: Calculations or direct logical conclusions based on raw numbers.",
    "   - HYPOTHESIS: Possibilities to explain trends that need testing.",
    "2. NO FABRICATION: Never fabricate or hallucinate any campaign IDs, ad IDs, account IDs, or metric values.",
    "3. WRITE CONFIRMATION: Never claim a mutation occurred unless you receive tool execution status confirmation.",
    "4. NO GUARANTEES: Never guarantee performance improvements or campaign success.",
    "",
    "=== WORKFLOW RULES ===",
    "1. READ-FIRST FOR ANALYSIS: When users ask analytical questions, always fetch the data first using read tools, analyze, and then explain. Never perform or suggest write mutations.",
    "2. RECOMMENDATION FLOW: When recommending optimizations, present the data evidence, metric anomalies, diagnosis, specific recommendations, risk profiles, and confidence level. Do NOT execute any write directly; present options clearly to the user.",
    "3. WRITE SAFETY & APPROVALS: For modification requests, select the appropriate write tool. The system automatically intercepts these write tools to generate pending actions for human approval. Inform the user of the pending approval ID cleanly and instruct them to confirm.",
    "4. SECURITY: Never reveal Meta access tokens or internal API credentials.",
    "",
    "=== RESPONSE FORMATTING ===",
    "When providing analytical reports or diagnostic insights, prefer this structured layout if suitable:",
    "- **Summary**: High-level overview.",
    "- **Evidence**: Metrics, anomalies, and facts.",
    "- **Diagnosis**: Explanation of performance trends.",
    "- **Recommendation**: Concrete optimization action.",
    "- **Risk & Confidence**: Risk level and confidence score.",
    "- **Next Step**: Actionable prompt.",
    "Do not force this format for simple conversational queries. Respect memory context preferences."
  ].join("\n");

  const metaAgent = new MetaAdsAgent({
    provider: adapter,
    systemPrompt: metaAdsSystemPrompt,
    tools: toolDefsFor(AGENT_POLICIES[AGENT_IDS.metaAds]!.allowedTools),
  });

  // ---------------------------------------------------------------------------
  // Sprint 6 — specialized agent registration.
  //
  // `requirePolicy` makes the allowlist a property of the deployment: an agent
  // with no entry in the compiled-in policy table cannot be registered at all,
  // so there is no path to a production agent running unrestricted.
  //
  // Each agent is offered ONLY the tool definitions its policy allows. That is
  // prompt hygiene rather than the security boundary — the Orchestrator checks
  // the same policy again before executing anything — but it stops a model
  // being tempted by a tool it would only be denied.
  //
  // Integration-backed agents register only when their tool actually exists.
  // With WhatsApp or n8n unconfigured the agent is absent, the router's next
  // candidate is taken, and the request lands on the general assistant instead
  // of on an agent that could not have helped.
  // ---------------------------------------------------------------------------
  const agentRegistry = new AgentRegistry({ requirePolicy: true });
  agentRegistry.register(agent);
  agentRegistry.register(metaAgent);

  agentRegistry.register(
    new KnowledgeAgent({
      provider: adapter,
      tools: toolDefsFor(AGENT_POLICIES[AGENT_IDS.knowledge]!.allowedTools),
    })
  );

  agentRegistry.register(
    new AnalyticsAgent({
      provider: adapter,
      tools: toolDefsFor(AGENT_POLICIES[AGENT_IDS.analytics]!.allowedTools),
    })
  );

  if (hasTool("google.accounts")) {
    agentRegistry.register(
      new GoogleAdsAgent({
        provider: adapter,
        tools: toolDefsFor(AGENT_POLICIES[AGENT_IDS.googleAds]!.allowedTools),
      })
    );
  }

  if (hasTool("n8n.trigger")) {
    agentRegistry.register(
      new AutomationAgent({
        provider: adapter,
        tools: toolDefsFor(AGENT_POLICIES[AGENT_IDS.automation]!.allowedTools),
        workflows: new PrismaN8nRepository(prisma),
      })
    );
  }

  if (hasTool("whatsapp.send")) {
    agentRegistry.register(
      new CommunicationAgent({
        provider: adapter,
        tools: toolDefsFor(AGENT_POLICIES[AGENT_IDS.communication]!.allowedTools),
        conversations: new PrismaWhatsAppRepository(prisma),
      })
    );
  }

  // Sprint 7 — gated on the tools actually being registered, so a deployment
  // with browsing switched off never offers an agent that cannot act.
  if (hasTool("browser.navigate")) {
    agentRegistry.register(
      new BrowserAgent({
        provider: adapter,
        tools: toolDefsFor(AGENT_POLICIES[AGENT_IDS.browser]!.allowedTools),
      })
    );
  }

  // Maps. Gated the same way as the others for consistency, but the guard is
  // effectively always true: the maps tools register unconditionally because
  // the geo layer answers from OpenStreetMap without a Google key. The check
  // stays so that removing the tools removes the agent, rather than leaving an
  // agent whose whole allowlist is missing.
  if (hasTool("maps.route")) {
    agentRegistry.register(
      new LocationAgent({
        provider: adapter,
        tools: toolDefsFor(AGENT_POLICIES[AGENT_IDS.location]!.allowedTools),
      })
    );
  }

  // Phase 15 — the marketing workspace. Gated like the others, and like the
  // maps agent the guard is effectively always true: the workspace tools reach
  // only JARVIS's own database, so they register on every deployment. What
  // differs between deployments is what the agent is OFFERED — the two page
  // reads and the two publish tools are in its definitions only where they
  // were registered above.
  if (hasTool("marketing.content.list")) {
    agentRegistry.register(
      new MarketingAgent({
        provider: adapter,
        tools: toolDefsFor(AGENT_POLICIES[AGENT_IDS.marketing]!.allowedTools),
        // Its prompt follows the tools above: with the publish tools it is
        // told how to publish, and without them it is told this instead.
        publishingUnavailableReason: marketingPublishingUnavailableReason,
      })
    );
  }

  console.log(JSON.stringify({
    level: "info",
    event: "agent_registration",
    agents: agentRegistry.getAll().map((a) => ({
      id: a.id,
      domain: agentRegistry.getPolicy(a.id)?.domain,
      tools: agentRegistry.getPolicy(a.id)?.allowedTools.length ?? 0,
    })),
  }));

  const toolApprovalService = new ToolApprovalService(approvalRepo, auditRepo, permissionService);

  // Wrap registry so the orchestrator resolves sanitized LLM tool names
  // (e.g. "meta-insights") back to original registry IDs (e.g. "meta.insights").
  // The executor ALSO needs this mapping — it receives the sanitized name from
  // the LLM and must resolve it before looking up the tool in the real registry.
  const resolvingRegistry = sanitizedToOriginal.size > 0
    ? {
        get(toolId: string) {
          const original = sanitizedToOriginal.get(toolId) ?? toolId;
          return toolRegistry.get(original);
        },
        getAll: () => toolRegistry.getAll(),
      }
    : toolRegistry;

  const toolExecutor = new ToolExecutor(
    resolvingRegistry,
    permissionService,
    approvalService,
    auditLogger,
    // Phase 17 — a tool that acts through a shared connection is refused,
    // before any approval exists, to anyone its Organization role does not
    // allow. The tool itself checks again as it runs.
    { lifecycle: options?.lifecycle, accessGate: sharedToolGate }
  );

  // Phase 15 — the marketing service reads the ad account through this
  // executor and no other way. Bound now that it exists.
  executorRef.current = toolExecutor;

  // Phase 15 — the page's way to ask for a publish. The SAME executor, the SAME
  // approval store and the SAME role table as everything else: it sequences
  // them and adds no check of its own.
  const marketingPublishFlow = new MarketingPublishFlow({
    executor: toolExecutor,
    approvals: approvalRepo,
    tools: toolRegistry,
    permissions: permissionService,
    ...(marketingPublishingUnavailableReason ? { unavailableMessage: marketingPublishingUnavailableReason } : {}),
  });

  // Task Execution V1 — the sequencer, over the two services built above.
  //
  // It receives the SAME executor every other write path uses, so a task
  // cannot skip a permission check, an approval or an audit row; and the SAME
  // allowlist CapabilityService is built with, so a task cannot reach a tool
  // no agent may propose. Both are narrowing, never widening.
  // ONE allowlist, shared by the planner and the executor. If these could
  // drift, the planner could propose something `executeTask` would then
  // refuse — a plan the user is told is runnable and is not.
  //
  // S8.4 — everything any agent may call EXCEPT the MCP group: MCP tools are
  // granted for a conversation with a person present, never for unattended,
  // scheduled work.
  const taskToolAllowlist = schedulableToolIds();

  taskExecutionService = new TaskExecutionService({
    tasks: taskService,
    executor: toolExecutor,
    allowedToolIds: taskToolAllowlist,
  });

  // Task Planner V1 — proposes, never runs.
  //
  // It receives the registry for READING (catalogue + validation) and the
  // configured provider through the existing IAIProvider abstraction. It is
  // deliberately NOT given the executor: there is no code path from a plan to
  // a side effect that does not go through TaskExecutionService.
  taskPlannerService = new TaskPlannerService({
    provider: adapter,
    registry: toolRegistry,
    allowedToolIds: taskToolAllowlist,
  });

  // The conversational sequencer. Same three services the REST endpoints use,
  // so "check this site" in chat and POST /plan + POST /execute follow one
  // path with one set of rules.
  // Scheduler V1 — built before the conversation service, which takes it.
  taskSchedulerService = new TaskSchedulerService({
    tasks: taskRepository,
    taskService,
    planner: taskPlannerService,
    execution: taskExecutionService,
    // V2.2 — abandoned-claim threshold, from the validated config layer.
    ...(options?.claimRecoveryAfterMs !== undefined
      ? { claimRecoveryAfterMs: options.claimRecoveryAfterMs }
      : {}),
    // V2.3 — the evidence read side, narrowed to one method.
    audit: { findExecutionOutcome: (u, e, s) => auditRepo.findExecutionOutcome(u, e, s) },
    ...(options?.runningRecoveryGraceMs !== undefined
      ? { runningRecoveryGraceMs: options.runningRecoveryGraceMs }
      : {}),
    // V2.1 — the same one-line JSON shape every other background component
    // logs in, so `task_schedule_claimed` sits beside `task_scheduler_*`.
    log: (level, event, meta) => {
      console.log(JSON.stringify({ level, event, ...(meta ?? {}) }));
    },
  });

  taskConversationService = new TaskConversationService({
    tasks: taskService,
    planner: taskPlannerService,
    execution: taskExecutionService,
    scheduler: taskSchedulerService,
  });

  // PHASE 11.9 — Pending action service for write-tool confirmation flow
  const pendingActionService = new PendingActionService({
    approvalRepo,
    toolRegistry: resolvingRegistry,
  });

  // ---------------------------------------------------------------------------
  // Sprint 1.1A — Persistent Memory Store Wiring
  // Wire PrismaMemoryRepository → MemoryExtractionService → Orchestrator.
  // Graceful degradation: without OPENAI_API_KEY memory is disabled and the
  // application still starts. That was not true until R-21: the chat adapter
  // above threw first, so the process exited before reaching this block.
  // ---------------------------------------------------------------------------

  let memoryStore: IMemoryStore | null = null;
  let embeddingProvider: IEmbeddingProvider | null = null;
  let memoryExtractor: IMemoryExtractor | null = null;

  try {
    // A whitespace-only key would still construct the embedding provider
    // below, and every recall would then fail at OpenAI. It counts as absent,
    // the same rule the chat provider above follows.
    if (!openAIConfigured) {
      throw new Error("OPENAI_API_KEY is not set");
    }

    // PrismaMemoryRepository is always safe to instantiate — no API key needed.
    // S7.2 L5 — the same instance memory management uses.
    memoryStore = memoryRepository;

    // OpenAIEmbeddingProvider throws if OPENAI_API_KEY is absent.
    embeddingProvider = new OpenAIEmbeddingProvider();

    // MemoryExtractionService reuses the same OpenAIAdapter already wired for
    // the ConversationalAssistant — no second AI client is created.
    const writer = new MemoryExtractionService({
      aiProvider: adapter,
      store: memoryStore,
      embeddingProvider,
      // S7.2 L5 — the user's pause and per-message vetoes, checked before the
      // model reads a turn and again just before anything is written.
      learningControl: { get: (userId) => memoryManagement.learningControl(userId) },
    });
    memoryExtractor = writer;
    // Phase 14 — the same instance corrects: there is one memory writer.
    memoryWriter.current = writer;

    console.log(JSON.stringify({
      level: "info",
      event: "memory_wiring",
      status: "persistent_memory_wired",
      store: memoryStore.id,
      embeddingProvider: embeddingProvider.id,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({
      level: "warn",
      event: "memory_wiring",
      status: "memory_disabled",
      reason: message,
    }));
    // Reset all to null so partial state is never used
    memoryStore = null;
    embeddingProvider = null;
    memoryExtractor = null;
    memoryWriter.current = null;
  }

  // ---------------------------------------------------------------------------
  // Sprint 3.7 — Knowledge retrieval wiring for RAG.
  // Reuses the SAME embedding provider the memory stack uses, so no second
  // client is created. Null without a provider: a query cannot be embedded, and
  // the orchestrator then behaves exactly as it did before this sprint.
  // ---------------------------------------------------------------------------
  let knowledgeRetriever: IKnowledgeRetriever | null = null;
  if (embeddingProvider !== null) {
    knowledgeRetriever = new KnowledgeRetrievalService({
      provider: embeddingProvider,
      repository: knowledgeRepo,
    });
  }
  console.log(JSON.stringify({
    level: "info",
    event: "knowledge_wiring",
    status: knowledgeRetriever ? "rag_enabled" : "rag_disabled_no_embedding_provider",
  }));

  // ---------------------------------------------------------------------------
  // Skill System V1, S3 — the skill-context port.
  //
  // Built from the SAME `CapabilityService` the capability tools and the
  // self-knowledge service use. There is no second capability derivation here:
  // this asks for the one report and projects it with `buildSkillContext`,
  // which is itself a projection of `buildSkillViews`.
  //
  // WHAT IT CANNOT DO. It returns prose-shaped metadata. It does not touch the
  // tool definitions handed to any agent, and the Orchestrator re-checks every
  // resulting tool call against `AGENT_POLICIES` afterwards. Passing the
  // agent's own allowlist in is what keeps the context from ever describing
  // reach the selected agent does not have.
  //
  // NO CACHE, DELIBERATELY. Availability is a fact about right now; a cached
  // one survives a token expiring and turns into a false promise. The report
  // is built per turn, alongside memory recall and knowledge retrieval in the
  // same `Promise.all`, so it costs wall-clock time only if it is the slowest
  // of the three.
  //
  // Absent when `capabilityService` is null (no integration command service on
  // this deployment), in which case the Orchestrator composes no skill block.
  // ---------------------------------------------------------------------------
  const skillContextProvider = capabilityService
    ? {
        async forAgent(userId: string, allowedToolIds: ReadonlySet<string>) {
          const report = await capabilityService.report(userId);
          return buildSkillContext(report, allowedToolIds);
        },
      }
    : null;

  // S5 — built from the SAME audit repository and the SAME logger every other
  // path already uses. No second store, no second pipeline, no schema change:
  // an execution outcome is a projection of rows that already exist, and a
  // feedback signal is one more audited user action beside them.
  const executionOutcomes = new ExecutionOutcomeService({
    audit: auditRepo,
    auditLogger,
  });

  // S6 — the same audit repository S5 reads, the conversation repository for
  // the request bound to the trace (PD-2), and ONLY the risk level of a tool
  // from the registry. The service never receives the registry itself, so it
  // cannot look a tool up to run it.
  const objectiveEvaluations = new ObjectiveEvaluationService({
    audit: auditRepo,
    messages: conversationRepo,
    riskOf: (toolId: string) => resolvingRegistry.get(toolId)?.risk,
  });

  const orchestrator = new Orchestrator(agentRegistry, toolExecutor, auditLogger, {
    toolRegistry: resolvingRegistry,
    toolApprovalService,
    // Sprint 6 — the agent permission floor is checked with the SAME service
    // the tool layer uses, so selecting an agent can never widen a role.
    permissionChecker: permissionService,
    pendingActionService: pendingActionService as unknown,
    // Sprint 1.1A: wire persistent memory into orchestrator
    ...(memoryStore !== null && embeddingProvider !== null
      ? {
          memoryStore,
          embeddingProvider,
          ...(memoryExtractor !== null ? { memoryExtractor } : {}),
          // Phase 14 — a memory learned from a message the user vetoed is not
          // recalled, and controls that cannot be read — or are corrupt
          // (audit F1) — recall nothing. A valid pause does not stop recall.
          memoryControl: { get: (userId: string) => memoryManagement.recallControl(userId) },
        }
      : {}),
    // Sprint 3.7: RAG context injection. Absent when no provider is configured.
    ...(knowledgeRetriever !== null ? { knowledgeRetriever } : {}),
    // S3: skill-aware planning context. Absent leaves the prompt untouched.
    ...(skillContextProvider !== null ? { skillContext: skillContextProvider } : {}),
    // Phase 15: the publish tools where publishing is off, and the page reads
    // where page reads are off — each with why.
    switchedOffTools: marketingSwitchedOffTools,
    // Phase 17: the same gate the executor asks, asked before a pending action
    // is created — a write nobody could let this caller make is refused now.
    accessGate: sharedToolGate,
  });

  const recommendationRepo = new PrismaRecommendationRepository(prisma);

  // ---------------------------------------------------------------------------
  // Phase 14 — the retention sweep.
  //
  // It reads user ids and nothing else, and it deletes nothing itself: each
  // user's long-expired memories are purged by `memory.purge_expired`, run
  // through the SAME ToolExecutor as every other tool — permission check,
  // audit row and all — as that user. A refused or failed run is a failure of
  // that one user's purge and is counted, never retried in a loop.
  // ---------------------------------------------------------------------------
  const memoryRetention = new MemoryRetentionSweep({
    candidates: (before, limit, after) => memoryRepository.usersWithExpiredMemories(before, limit, after),
    purge: async (userId) => {
      const run = await toolExecutor.execute({
        toolId: MEMORY_PURGE_TOOL_ID,
        params: {},
        userId,
        role: "member",
        traceId: randomUUID(),
      });
      if (run.status !== "completed" || !run.result?.success) throw new Error("memory.purge_expired did not complete");
      return Number((run.result.data as { purged?: unknown } | undefined)?.purged ?? 0);
    },
  });

  // The execution authority, bound once now that it exists. An integration
  // action requested by EITHER path therefore still runs through the permission
  // check, the approval gate and the journal: this service gates actions, it
  // does not execute them.
  integrationCommands?.setExecutor(toolExecutor);

  // ---------------------------------------------------------------------------
  // PHASE 11.10 — the shared analysis/recommendation-generation service.
  //
  // One instance, built now that the executor, the provider chain and the
  // durable recommendation store all exist, and shared by the `meta.analyze`
  // JARVIS tool AND the POST /api/v1/analysis route — the same object-graph
  // guarantee the integration command service makes for its two paths.
  //
  // Gated on Meta credentials AND an AI provider: analysis must read the
  // account through the executor and produce a diagnosis through the provider,
  // so without either the service stays null and the route reports a 503 with
  // the precise missing piece instead of pointing at a service that can only
  // fail. The tool is registered only alongside the service, so an agent can
  // never be offered an analysis it cannot actually perform.
  // ---------------------------------------------------------------------------
  const metaAccessTokenConfigured = process.env.META_ACCESS_TOKEN;
  const metaAccountIdConfigured = process.env.META_AD_ACCOUNT_ID;
  const analysisService =
    metaAccessTokenConfigured && metaAccountIdConfigured && openAIConfigured
      ? new AnalysisGenerator({
          executor: toolExecutor,
          provider: adapter,
          store: recommendationRepo,
          audit: auditLogger,
          config: { defaultAccountId: metaAccountIdConfigured },
        })
      : null;

  // The tool was registered above, before the agents' definitions were taken,
  // on the same condition; this is the service it has been waiting for.
  analysisRef.current = analysisService;


  _container = {
    tokenService,
    authService,
    orchestrator,
    conversationRepo,
    auditLogger,
    executionOutcomes,
    objectiveEvaluations,
    executionJournal,
    approvalRepo,
    toolRegistry,
    agentRegistry,
    integrationCommands,
    capabilities: capabilityService,
    googleWorkspace: googleWorkspaceService,
    googleWrites: googleWriteService,
    executor: toolExecutor,
    recommendationRepo,
    analysisService,
    lifecycle: options?.lifecycle,
    pendingActionService,
    // Sprint 1.1A — expose memory stack for diagnostics and tests
    memoryStore,
    embeddingProvider,
    memoryExtractor,
    // S7.2 L5 — the chat route's memory commands read it through a narrow port.
    memoryManagement,
    // Phase 14 — projects, the correction check and the retention sweep.
    projects: projectRepo,
    // Phase 17 Stage 3A — the tenant reads the n8n MCP routes authorize with.
    tenantRepo,
    // Phase 17 — the one answer to who may use a shared connection.
    sharedAccess,
    ...(memoryWriter.current
      ? { memoryCorrections: { check: (input: Parameters<MemoryCorrectionCheckPort["check"]>[0]) => memoryWriter.current!.checkCorrection(input) } }
      : {}),
    memoryRetention,
    knowledgeRepo,
    knowledgeRetriever,
    // Core V1 — the first persistent work primitive, and self-knowledge.
    taskService,
    selfKnowledge: selfKnowledgeService,
    taskExecution: taskExecutionService!,
    taskPlanner: taskPlannerService!,
    taskConversation: taskConversationService!,
    taskScheduler: taskSchedulerService!,
    // Phase 15 — the marketing workspace service the tools hold.
    marketing: marketingService,
    marketingPublishFlow,
    marketingPublishingUnavailableReason,
    permissions: permissionService,
    // Phase 18, Stage 18.1 — the persistent n8n workflow catalog.
    automationLibrary,
    // Phase 18.2 — the voice marker's server-side half.
    recentTranscripts: new RecentTranscripts(),
    // Phase 18.3B — the Automations page's apply, through the executor.
    automationLibraryAllowlist: new LibraryAllowlistFlow({ executor: toolExecutor, approvals: approvalRepo, audit: auditLogger }),
    // Phase 18.4 — workflow planning and drafts.
    automationPlanning,
  };

  return _container;
}

/**
 * Sprint 7 — the shared browser, or null when browsing is off.
 *
 * Exposed so the shutdown controller can close Chrome during RELEASE_RESOURCES
 * rather than orphaning it when the API exits.
 */
export function getBrowserRuntime(): BrowserRuntimePort | null {
  return _browserRuntime;
}

/**
 * S8.4 — the MCP connections, empty unless MCP is switched on. Exposed so the
 * shutdown controller can close them during RELEASE_RESOURCES, leaving no MCP
 * server process behind.
 */
export function getMcpConnections(): readonly McpConnection[] {
  return _mcpConnections;
}

/**
 * S8.7 — the n8n MCP connector, or null when that surface is off or could not
 * be built. Exposed so the shutdown controller closes its HTTP session during
 * RELEASE_RESOURCES, and so a test can assert the gate rather than reach a
 * network.
 */
export function getN8nMcpConnector(): N8nMcpConnector | null {
  return _n8nMcpConnector;
}

export function resetContainer(): void {
  _container = null;
  _browserRuntime = null;
  _mcpConnections = [];
  _n8nMcpConnector = null;
}
