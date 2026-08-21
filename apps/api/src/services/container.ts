import type { IOrchestrator } from "@jarvis/core";
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
} from "@jarvis/db";

export interface Container {
  tokenService: TokenService;
  authService: AuthManager;
  orchestrator: IOrchestrator;
  conversationRepo: PrismaConversationRepository;
  auditLogger: AuditLogger;
}

let _container: Container | null = null;

const noopApprovalRepo = {
  create: async () => ({ id: "", userId: "", toolId: "", action: "", params: {}, status: "pending" as const, expiresAt: "", createdAt: "" }),
  findById: async () => null,
  updateStatus: async () => null,
  findPending: async () => [],
  findExistingForTool: async () => null,
};

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

export function getContainer(): Container {
  if (_container) return _container;

  const tokenSecret = process.env.JWT_SECRET;
  if (!tokenSecret) {
    throw new Error("JWT_SECRET is required");
  }

  const tokenService = new TokenServiceImpl(tokenSecret);

  const auditRepo = new PrismaAuditRepository(prisma);
  const auditLogger = new AuditLogger(auditRepo);

  const conversationRepo = new PrismaConversationRepository(prisma);

  const passwordHasher = new PasswordHasher();
  const userRepo = new PrismaUserRepository(prisma);
  const refreshTokenRepo = new PrismaRefreshTokenRepository(prisma);
  const authService = new AuthManager(passwordHasher, tokenService, refreshTokenRepo, userRepo);

  const permissionService = new PermissionService();
  const approvalService = new ApprovalService(noopApprovalRepo);

  const toolRegistry = createMetaToolRegistry();
  const toolExecutor = new ToolExecutor(
    toolRegistry,
    permissionService,
    approvalService,
    auditLogger
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
  };

  return _container;
}

export function resetContainer(): void {
  _container = null;
}
