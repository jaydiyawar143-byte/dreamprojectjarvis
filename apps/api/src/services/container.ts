import type { IOrchestrator, IToolExecutor, ITool, AIToolDefinition, ShutdownLifecycle } from "@jarvis/core";
import type { TokenService } from "@jarvis/security";
import { Orchestrator, AgentRegistry, ConversationalAssistant } from "@jarvis/agents";
import { OpenAIAdapter } from "@jarvis/ai-openai";
import {
  ToolExecutor,
  ToolRegistry,
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
} from "@jarvis/tools";
import { createMetaGraphProvider } from "@jarvis/meta-graph";
import {
  PermissionService,
  ApprovalService,
  ToolApprovalService,
  TokenService as TokenServiceImpl,
  AuditLogger,
  PasswordHasher,
  AuthManager,
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
} from "@jarvis/db";

export interface Container {
  tokenService: TokenService;
  authService: AuthManager;
  orchestrator: IOrchestrator;
  conversationRepo: PrismaConversationRepository;
  auditLogger: AuditLogger;
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
   * PHASE 11.6B — executor exposed for recommendation execution route so
   * the RecommendationExecutionService can route all writes through the
   * SAME Phase 10 authority (approval + journal + concurrency).
   */
  executor: IToolExecutor;
  /**
   * PHASE 11.6B — durable recommendation store for the execution route.
   */
  recommendationRepo: PrismaRecommendationRepository;
  /** Lifecycle gate consulted before approving side-effecting actions. */
  lifecycle?: ShutdownLifecycle;
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

let _container: Container | null = null;

function createMetaToolRegistry(
  approvalConsumption: PrismaApprovalRepository
): ToolRegistry {
  const registry = new ToolRegistry();
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

    // Phase 8: Read-only tools (provider doubles as its own authorizer)
    registry.register(new MetaGetAccountsTool(realProvider, realProvider));
    registry.register(new MetaGetCampaignsTool(realProvider, realProvider));
    registry.register(new MetaGetAdSetsTool(realProvider, realProvider));
    registry.register(new MetaGetAdsTool(realProvider, realProvider));
    registry.register(new MetaGetInsightsTool(realProvider, realProvider));

    // Phase 9.1: Write tools (pause/resume)
    registry.register(new MetaPauseCampaignTool(realProvider, realProvider, executionJournal, approvalConsumption));
    registry.register(new MetaResumeCampaignTool(realProvider, realProvider, executionJournal, approvalConsumption));
    registry.register(new MetaPauseAdSetTool(realProvider, realProvider, executionJournal, approvalConsumption));
    registry.register(new MetaResumeAdSetTool(realProvider, realProvider, executionJournal, approvalConsumption));
    registry.register(new MetaPauseAdTool(realProvider, realProvider, executionJournal, approvalConsumption));
    registry.register(new MetaResumeAdTool(realProvider, realProvider, executionJournal, approvalConsumption));

    // Phase 9.2: Budget tools
    registry.register(new MetaUpdateCampaignBudgetTool(realProvider, realProvider, undefined, executionJournal, approvalConsumption));
    registry.register(new MetaUpdateAdSetBudgetTool(realProvider, realProvider, undefined, executionJournal, approvalConsumption));

    // Phase 9.3: Campaign creation
    registry.register(new MetaCreateCampaignTool(realProvider, realProvider, undefined, executionJournal, approvalConsumption));
  }

  return registry;
}

export function getContainer(options?: {
  /**
   * Phase 10.6 — lifecycle gate wired into the ToolExecutor so draining
   * blocks new side-effecting executions (and approval consumption) at the
   * earliest safe point.
   */
  lifecycle?: ShutdownLifecycle;
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

  const permissionService = new PermissionService();
  // PHASE 10.7 — real durable approval store replaces the Phase-0 noop repo.
  const approvalRepo = new PrismaApprovalRepository(prisma);
  const approvalService = new ApprovalService(approvalRepo);

  const toolRegistry = createMetaToolRegistry(approvalRepo);
  const toolExecutor = new ToolExecutor(
    toolRegistry,
    permissionService,
    approvalService,
    auditLogger,
    { lifecycle: options?.lifecycle }
  );

  const adapter = new OpenAIAdapter();

  const { definitions: agentTools, sanitizedToOriginal } = convertToolsToAIToolDefinitions(toolRegistry.getAll());

  const systemPrompt = [
    "You are JARVIS, a helpful AI assistant with direct access to the user's Meta Ads account.",
    "",
    "You have tools to read and manage Meta Ads campaigns. The Meta ad account ID is already configured in the system — you do NOT need to ask the user for it.",
    "",
    "When the user asks about their Meta Ads performance, campaigns, ad sets, ads, or insights, use the appropriate tool to fetch real data. Do NOT say you cannot access the account.",
    "",
    "For read-only queries (performance, metrics, lists), use the tools directly.",
    "For write operations (pause, resume, budget changes, create campaign), explain what you will do and get confirmation first.",
    "",
    "DATE RANGE DEFAULTS:",
    "- If the user asks about 'current performance' or 'recent performance' or doesn't specify dates, use the last 30 days.",
    "- If the user says 'this week', use the last 7 days.",
    "- If the user says 'this month', use the first day of the current month to today.",
    "- If the user says 'last month', use the first day of the previous month to the last day of the previous month.",
    "- Always use YYYY-MM-DD format.",
    "- Do NOT ask the user for dates if you can infer a reasonable default.",
    "",
    "CRITICAL RULES — ANTI-HALLUCINATION:",
    "- NEVER invent, estimate, or fabricate Meta Ads metrics (Spend, CTR, CPC, CPM, CPA, conversions, ROAS, impressions, clicks, or any other numeric values).",
    "- ONLY report data that was ACTUALLY returned by a tool. Check each tool result's STATUS field.",
    "- If a tool's STATUS is not COMPLETED, or if DATA_RETRIEVAL_FAILED appears, you MUST NOT present any metrics as factual values.",
    "- If data retrieval failed, explicitly state: 'Meta data retrieval failed' and include the ERROR from the tool result.",
    "- When presenting real data, include provenance: source (Meta API), account ID, and date range.",
    "- If a tool returns DATA: (empty — no data returned), state that no data was found for the specified criteria.",
    "- Never say 'Source: Meta API' unless the tool actually returned real data with STATUS: COMPLETED.",
  ].join("\n");

  const agent = new ConversationalAssistant({
    provider: adapter,
    systemPrompt,
    tools: agentTools,
  });

  const agentRegistry = new AgentRegistry();
  agentRegistry.register(agent);

  const toolApprovalService = new ToolApprovalService(approvalRepo, auditRepo, permissionService);

  // Wrap registry so the orchestrator resolves sanitized LLM tool names
  // (e.g. "meta-insights") back to original registry IDs (e.g. "meta.insights").
  const resolvingRegistry = sanitizedToOriginal.size > 0
    ? {
        get(toolId: string) {
          const original = sanitizedToOriginal.get(toolId) ?? toolId;
          return toolRegistry.get(original);
        },
        getAll: () => toolRegistry.getAll(),
      }
    : toolRegistry;

  const orchestrator = new Orchestrator(agentRegistry, toolExecutor, auditLogger, {
    toolRegistry: resolvingRegistry,
    toolApprovalService,
  });

  const recommendationRepo = new PrismaRecommendationRepository(prisma);

  _container = {
    tokenService,
    authService,
    orchestrator,
    conversationRepo,
    auditLogger,
    executionJournal,
    approvalRepo,
    toolRegistry,
    executor: toolExecutor,
    recommendationRepo,
    lifecycle: options?.lifecycle,
  };

  return _container;
}

export function resetContainer(): void {
  _container = null;
}
