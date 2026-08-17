import type { IOrchestrator } from "@jarvis/core";
import type { TokenService } from "@jarvis/security";
import { Orchestrator, AgentRegistry, ConversationalAssistant } from "@jarvis/agents";
import { OpenAIAdapter } from "@jarvis/ai-openai";
import { ToolExecutor } from "@jarvis/tools";
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

  const toolExecutor = new ToolExecutor(
    { get: () => undefined } as any,
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
