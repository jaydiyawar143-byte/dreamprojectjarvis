import type { IOrchestrator, ShutdownLifecycle } from "@jarvis/core";
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
  /** Lifecycle gate consulted before approving side-effecting actions. */
  lifecycle?: ShutdownLifecycle;
}

let _container: Container | null = null;

function createMetaToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const metaAccessToken = process.env.META_ACCESS_TOKEN;
  const metaAccountId = process.env.META_AD_ACCOUNT_ID;

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
    registry.register(new MetaPauseCampaignTool(realProvider, realProvider, executionJournal));
    registry.register(new MetaResumeCampaignTool(realProvider, realProvider, executionJournal));
    registry.register(new MetaPauseAdSetTool(realProvider, realProvider, executionJournal));
    registry.register(new MetaResumeAdSetTool(realProvider, realProvider, executionJournal));
    registry.register(new MetaPauseAdTool(realProvider, realProvider, executionJournal));
    registry.register(new MetaResumeAdTool(realProvider, realProvider, executionJournal));

    // Phase 9.2: Budget tools
    registry.register(new MetaUpdateCampaignBudgetTool(realProvider, realProvider, undefined, executionJournal));
    registry.register(new MetaUpdateAdSetBudgetTool(realProvider, realProvider, undefined, executionJournal));

    // Phase 9.3: Campaign creation
    registry.register(new MetaCreateCampaignTool(realProvider, realProvider, undefined, executionJournal));
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

  const toolRegistry = createMetaToolRegistry();
  const toolExecutor = new ToolExecutor(
    toolRegistry,
    permissionService,
    approvalService,
    auditLogger,
    { lifecycle: options?.lifecycle }
  );

  const adapter = new OpenAIAdapter();

  const agent = new ConversationalAssistant({
    provider: adapter,
    systemPrompt: "You are JARVIS, a helpful AI assistant.",
  });

  const agentRegistry = new AgentRegistry();
  agentRegistry.register(agent);

  const orchestrator = new Orchestrator(agentRegistry, toolExecutor, auditLogger);

  _container = {
    tokenService,
    authService,
    orchestrator,
    conversationRepo,
    auditLogger,
    executionJournal,
    approvalRepo,
    toolRegistry,
    lifecycle: options?.lifecycle,
  };

  return _container;
}

export function resetContainer(): void {
  _container = null;
}
